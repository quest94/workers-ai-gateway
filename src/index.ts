export interface Env {
  AI: Ai;
  AUTH_KEY: string;
}

async function parseSSEChunks(
  rawChunks: AsyncIterable<string | Uint8Array>,
  onText: (text: string) => void
) {
  let buffer = "";
  for await (const chunk of rawChunks) {
    const raw = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    buffer += raw;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed === "data: [DONE]") continue;
      const data = trimmed.replace(/^data:\s*/, "");
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as { response?: string; response_text?: string };
        const text = parsed.response ?? parsed.response_text ?? "";
        if (text) onText(text);
      } catch {
        // 忽略非 JSON 行
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 基础认证检查（如果设置了 AUTH_KEY）
    if (env.AUTH_KEY && request.headers.get("Authorization") !== `Bearer ${env.AUTH_KEY}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    // CORS 预检处理
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // 1. 模型列表接口 (OpenAI 兼容)
    if (url.pathname === "/v1/models") {
      const models = {
        object: "list",
        data: [
          {
            id: "@cf/qwen/qwen2.5-coder-32b-instruct",
            object: "model",
            created: 1677610602,
            owned_by: "qwen",
          },
        ],
      };
      return new Response(JSON.stringify(models), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 2. 聊天补全接口
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      try {
        const body = await request.json<any>();
        const { model, messages, stream = false, stream_options } = body;

        // 简单的请求参数校验
        if (!model || !messages || !Array.isArray(messages)) {
          return new Response("Bad Request", { status: 400 });
        }

        // 检查是否需要返回 usage
        const includeUsage = stream_options?.include_usage === true;

        // 修正后的 token 估算函数（双字节1token，单字节0.25token）
        const calculateTokens = (text: string) => {
          if (!text) return 0;
          let tokens = 0;
          const doubleByteRegex = /[\u4e00-\u9fa5\u0800-\u4e00\uac00-\ud7af]/;
          for (const char of text) {
            tokens += doubleByteRegex.test(char) ? 1 : 0.25;
          }
          return Math.ceil(tokens);
        };

        let promptTokens = 0;
        for (const msg of messages) {
          if (typeof msg.content === "string") {
            promptTokens += calculateTokens(msg.content);
          } else if (Array.isArray(msg.content)) {
            for (const contentPart of msg.content) {
              if (contentPart.type === "text") {
                promptTokens += calculateTokens(contentPart.text || "");
              }
            }
          }
        }

        // 执行 Workers AI 推理（始终开启流式接收，前端按需处理）
        // @ts-ignore
        const aiResponse = await env.AI.run(model, {
          messages: messages.map((m: any) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content :
                     (Array.isArray(m.content)
                       ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                       : ""),
          })),
          stream: true,
        });

        if (stream) {
          // ===== 流式响应分支 =====
          const responseStream = new ReadableStream({
            async start(controller) {
              let completionTokens = 0;
              let heartbeat: ReturnType<typeof setInterval> | null = null;

              const startHeartbeat = () => {
                if (heartbeat) clearInterval(heartbeat);
                heartbeat = setInterval(() => {
                  controller.enqueue(new TextEncoder().encode(`: heartbeat\n\n`));
                }, 15000);
              };

              const stopHeartbeat = () => {
                if (heartbeat) {
                  clearInterval(heartbeat);
                  heartbeat = null;
                }
              };

              try {
                // 发送初始块，带 role 防止客户端超时
                const initialChunk = JSON.stringify({
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
                });
                controller.enqueue(new TextEncoder().encode(`data: ${initialChunk}\n\n`));

                // 启动心跳，防止首 token 冷启动超时
                startHeartbeat();

                await parseSSEChunks(aiResponse as unknown as AsyncIterable<string | Uint8Array>, (text) => {
                  startHeartbeat();
                  completionTokens += calculateTokens(text);

                  const data = JSON.stringify({
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                  });
                  controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
                });

                // 无论是否请求 usage，都先发一个明确的 stop 收尾块
                const stopChunk = JSON.stringify({
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                });
                controller.enqueue(new TextEncoder().encode(`data: ${stopChunk}\n\n`));

                // 根据客户端是否请求 include_usage，发送 usage 收尾块
                if (includeUsage) {
                  const finalChunk = JSON.stringify({
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [],
                    usage: {
                      prompt_tokens: promptTokens,
                      completion_tokens: completionTokens,
                      total_tokens: promptTokens + completionTokens,
                    },
                  });
                  controller.enqueue(new TextEncoder().encode(`data: ${finalChunk}\n\n`));
                }

                // 发送结束标记
                controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
              } catch (e: any) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ error: String(e.message ?? e) })}\n\n`
                  )
                );
              } finally {
                stopHeartbeat();
                controller.close();
              }
            },
          });

          return new Response(responseStream, {
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "Access-Control-Allow-Origin": "*",
              "X-Accel-Buffering": "no",
            },
          });
        } else {
          // ===== 非流式响应分支 =====
          let fullText = "";
          await parseSSEChunks(aiResponse as unknown as AsyncIterable<string | Uint8Array>, (text) => {
            fullText += text;
          });

          const completionTokens = calculateTokens(fullText);

          const responseData = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: fullText,
                },
                finish_reason: "stop",
              },
            ],
          };

          return new Response(JSON.stringify(responseData), {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 健康检查
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
