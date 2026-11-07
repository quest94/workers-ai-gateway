
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
    // 只有传 stream:true 时，run 才返回【异步可迭代对象】，才能 for await
    if (stream) {
      const aiResponse = await c.env.AI.run(model, {
        messages: formattedMessages,
        stream: true,
      });

      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          for await (const chunk of aiResponse as any) {
            const text = chunk.response || '';
            const data =
              'data: ' +
              JSON.stringify({
                id: 'chatcmpl-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
              }) +
              '\n\n';
            controller.enqueue(encoder.encode(data));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
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
