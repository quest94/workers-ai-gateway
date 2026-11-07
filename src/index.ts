// src/index.ts

export interface Env {
  AI: Ai;
  AUTH_KEY: string; // 可以在 Cloudflare 环境变量或 .dev.vars 里设置，防止公开滥用
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
          // 可以在这里添加其他 Workers AI 模型
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
        const { model, messages, stream = false } = body;

        // 简单的请求参数校验
        if (!model || !messages || !Array.isArray(messages)) {
          return new Response("Bad Request", { status: 400 });
        }

        // 计算伪造的 token 数
        const calculateTokens = (text: string) => {
          if (!text) return 0;
          let tokens = 0;
          // 中文、日文、韩文等双字节字符算 1 token，其他算 1 token
          const doubleByteRegex = /[\u4e00-\u9fa5\u0800-\u4e00\uac00-\ud7af]/;
          for (const char of text) {
            tokens += doubleByteRegex.test(char) ? 1 : 0.25;
          }
          return tokens;
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

        // 执行 Workers AI 推理
        // @ts-ignore
        const aiResponse = await env.AI.run(model, {
          messages: messages.map((m: any) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : 
                     (Array.isArray(m.content) 
                       ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") 
                       : ""),
          })),
          stream: true, // 始终让 Workers AI 流式输出，前端自己决定要不要流式
        });

        if (stream) {
          // 流式响应分支
          const stream = new ReadableStream({
            async start(controller) {
              let completionTokens = 0;
              let isFirstChunk = true;

              try {
                // 先发送一个带 role 的空块，防止客户端冷启动超时
                const initialChunk = JSON.stringify({
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
                });
                controller.enqueue(new TextEncoder().encode(`data: ${initialChunk}\n\n`));

                // 发送心跳包，保持连接活跃
                const heartbeat = setInterval(() => {
                  controller.enqueue(new TextEncoder().encode(`: heartbeat\n\n`));
                }, 15000);

                for await (const chunk of aiResponse) {
                  clearInterval(heartbeat);
                  const text = chunk.response || "";
                  if (!text) continue;

                  completionTokens += calculateTokens(text);

                  const data = JSON.stringify({
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                  });
                  controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
                }

                // 发送带 usage 的完成块
                const finalChunk = JSON.stringify({
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens,
                  },
                });
                controller.enqueue(new TextEncoder().encode(`data: ${finalChunk}\n\n`));
                
                // 发送结束标记
                controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
              } catch (e: any) {
                controller.enqueue(new TextEncoder().encode(`data: {"error": "${e.message}"}\n\n`));
              } finally {
                controller.close();
              }
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } else {
          // 非流式响应分支
          let fullText = "";
          for await (const chunk of aiResponse) {
            fullText += chunk.response || "";
          }

          const completionTokens = calculateTokens(fullText);

          const responseData = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
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
