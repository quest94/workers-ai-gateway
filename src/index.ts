import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { OpenAPIHono, createRoute, z } from '@chanfana/core'; // 注意：如果原模板没有 @chanfana/core，可能需要调整 import，但通常 Hono 原生写法更通用。为了稳妥，我将使用纯 Hono 写法，兼容你的模板环境。

// 定义模型 ID，你可以随时在这里修改
const MODEL_ID = "@cf/qwen/qwen2.5-coder-32b-instruct";

const app = new Hono<{ Bindings: { AI: any } }>();

// 1. 启用 CORS，允许 CC-Switch (本地应用) 访问
app.use('/*', cors());

// 2. 处理 OPTIONS 预检请求
app.options('/*', (c) => c.text('', 204));

// 3. 核心路由：兼容 OpenAI 的 /v1/chat/completions 接口
app.post('/v1/chat/completions', async (c) => {
  try {
    const body = await c.req.json();
    const { messages, stream = false } = body;

    // 过滤掉 Workers AI 不支持的参数 (如 tools, tool_choice)
    // 防止 Claude Code 等工具调用时报错
    const cleanMessages = messages.map((msg: any) => ({
      role: msg.role,
      content: msg.content
    }));

    // 调用 Cloudflare Workers AI
    const response = await c.env.AI.run(MODEL_ID, {
      messages: cleanMessages,
      stream: stream
    });

    // 处理流式响应 (SSE)
    if (stream) {
      const encoder = new TextEncoder();
      const streamResponse = new ReadableStream({
        async start(controller) {
          for await (const chunk of response as any) {
            const text = chunk.response || "";
            const data = JSON.stringify({
              id: "chatcmpl-" + Date.now(),
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: MODEL_ID,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
            });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }
          // 发送结束标记
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        }
      });

      return new Response(streamResponse, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    } 
    
    // 处理非流式响应
    else {
      let fullText = "";
      for await (const chunk of response as any) {
        fullText += chunk.response || "";
      }

      return c.json({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }]
      });
    }

  } catch (e: any) {
    console.error("AI Error:", e);
    return c.json({ error: e.message }, 500);
  }
});

// 4. 默认首页测试
app.get('/', (c) => c.json({ status: "ok", message: "Workers AI Gateway is running" }));

export default app;
