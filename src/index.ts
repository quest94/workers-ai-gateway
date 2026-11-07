
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono<{ Bindings: { AI: any } }>();

// 默认模型，可按需修改
const DEFAULT_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';

// 开启 CORS，允许 CC-Switch 等本地应用跨域访问
app.use('*', cors());
app.options('*', (c) => c.text('', 204));

// ===== 把任意 content 归一成纯字符串 =====
// Anthropic / Claude Code 的 content 常常是数组（富文本块 / tool_result），
// Workers AI 的 @cf/qwen 只接受字符串，必须在这里拉平，否则报 5006 oneOf not met。
function toText(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        // 工具结果块：tool_result 的 content 可能是字符串或数组，递归拉平
        if (part.type === 'tool_result') return toText(part.content);
        // 其他块（图片等）无法作为文本喂给模型，直接丢弃
        return '';
      })
      .filter((s: string) => s.length > 0)
      .join('\n');
  }
  if (typeof content === 'object') {
    // 兜底：个别实现把 content 包成 {text: ...}
    if (typeof content.text === 'string') return content.text;
    return '';
  }
  return String(content);
}

// ===== 归一 role：Workers AI 只认 system / user / assistant =====
function toRole(role: any): string {
  if (role === 'system') return 'system';
  if (role === 'assistant') return 'assistant';
  // tool / function 等一律并入 user，避免非法 role 触发 schema 报错
  return 'user';
}

// 核心路由：兼容 OpenAI 的 /v1/chat/completions
app.post('/v1/chat/completions', async (c) => {
  try {
    const body = await c.req.json();
    const { messages, stream = false, model: requestedModel } = body;

    if (!messages || !Array.isArray(messages)) {
      return c.json({ error: 'Invalid messages format' }, 400);
    }

    // 规范化：role 收敛到三种合法值，content 全部转成字符串，并过滤掉空消息
    const formattedMessages = messages
      .map((m: any) => ({
        role: toRole(m.role),
        content: toText(m.content),
      }))
      .filter((m: any) => m.content.length > 0);

    if (formattedMessages.length === 0) {
      return c.json({ error: 'No usable messages after normalization' }, 400);
    }

    const model = requestedModel || DEFAULT_MODEL;

    // ===== 流式分支 =====
    // Workers AI 的 stream:true 返回的是【异步可迭代对象】(每次 yield {response:"片段"})，
    // 不是现成的 SSE 字节流，所以必须 for await 读出后自己封成 SSE 的 data: 行，不能直接 pipe。
    if (stream) {
      const aiResponse = await c.env.AI.run(model, {
        messages: formattedMessages,
        stream: true,
      });

      const encoder = new TextEncoder();
      const created = Math.floor(Date.now() / 1000);
      const id = 'chatcmpl-' + Date.now();
      const sse = (obj: any) => 'data: ' + JSON.stringify(obj) + '\n\n';

      const readable = new ReadableStream({
        async start(controller) {
          try {
            // 1) 立刻先发一个 role 首块：让客户端第一时间收到字节、确认流已建立，
            //    避免 32B 模型冷启动首 token 慢时被判定 "ended before any complete data"。
            controller.enqueue(
              encoder.encode(
                sse({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
                }),
              ),
            );

            // 2) 正常转发每个 token 片段
            for await (const chunk of aiResponse as any) {
              const text = chunk.response || '';
              if (!text) continue;
              controller.enqueue(
                encoder.encode(
                  sse({
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                  }),
                ),
              );
            }

            // 3) 收尾块：finish_reason = stop。OpenAI/Claude Code 据此判断流正常结束，
            //    缺少这块是 "streaming ended before complete data" 的常见诱因。
            controller.enqueue(
              encoder.encode(
                sse({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                }),
              ),
            );

            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          } catch (err: any) {
            // 上游流中途异常：发一个 error 块再关闭，避免连接挂死让客户端无限等待
            controller.enqueue(encoder.encode(sse({ error: err?.message || 'stream error' })));
          } finally {
            controller.close();
          }
        },
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          // no-transform 防止中间网关/代理二次缓冲你的流
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          // 关掉 Nginx 系代理的缓冲（部分出口/反代有效）
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // ===== 非流式分支 =====
    // 不传 stream 时，run 返回【普通对象】，直接取 .response，绝对不能 for await
    const result = await c.env.AI.run(model, { messages: formattedMessages });
    const text = (result as any).response;

    return c.json({
      id: 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
      ],
    });
  } catch (e: any) {
    console.error('AI Error:', e);
    return c.json({ error: e.message || 'Internal Server Error' }, 500);
  }
});

// 健康检查
app.get('/', (c) => c.json({ status: 'ok', message: 'Workers AI Gateway is running' }));

export default app;
