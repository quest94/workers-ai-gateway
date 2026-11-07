
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono<{ Bindings: { AI: any } }>();

// 默认模型，可按需修改
const DEFAULT_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';

// 开启 CORS，允许 CC-Switch 等本地应用跨域访问
app.use('*', cors());
app.options('/*', (c) => c.text('', 204));

// 核心路由：兼容 OpenAI 的 /v1/chat/completions
app.post('/v1/chat/completions', async (c) => {
  try {
    const body = await c.req.json();
    const { messages, stream = false, model: requestedModel } = body;

    if (!messages || !Array.isArray(messages)) {
      return c.json({ error: 'Invalid messages format' }, 400);
    }

    const formattedMessages = messages.map((m: any) => ({
      role: m.role === 'system' ? 'system' : m.role,
      content: m.content
    }));

    const model = requestedModel || DEFAULT_MODEL;

    // ===== 流式分支 =====
    // 只有传 stream:true 时，run 才返回【异步可迭代对象】，才能 for await
    if (stream) {
      const aiResponse = await c.env.AI.run(model, {
        messages: formattedMessages,
        stream: true
      });

      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          for await (const chunk of aiResponse as any) {
            const text = chunk.response || '';
            const data = 'data: ' + JSON.stringify({
              id: 'chatcmpl-' + Date.now(),
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
            }) + '\n\n';
            controller.enqueue(encoder.encode(data));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
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
        { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }
      ]
    });

  } catch (e: any) {
    console.error('AI Error:', e);
    return c.json({ error: e.message || 'Internal Server Error' }, 500);
  }
});

// 健康检查
app.get('/', (c) => c.json({ status: 'ok', message: 'Workers AI Gateway is running' }));

export default app;
