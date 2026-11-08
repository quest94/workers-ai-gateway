interface Env {
  AI: any;
  API_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 公开路径：不校验 API Key
    const publicPaths = ["/v1/models"];

    // 非公开路径：校验 API Key
    if (!publicPaths.includes(url.pathname)) {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

      if (!token || token !== env.API_KEY) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Invalid API key",
              type: "invalid_request_error",
            },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // 路由分发
    if (url.pathname === "/v1/models") {
      return handleModels();
    }

    if (url.pathname === "/v1/chat/completions") {
      return handleChat(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

function handleModels(): Response {
  const models = [
    {
      id: "@cf/qwen/qwen3-30b-a4b-fp8",
      object: "model",
      created: 1700000000,
      owned_by: "qwen",
    },
    {
      id: "@cf/zai-org/glm-4.7-flash",
      object: "model",
      created: 1700000001,
      owned_by: "zai-org",
    },
    {
      id: "@cf/qwen/qwen2.5-coder-32b-instruct",
      object: "model",
      created: 1700000002,
      owned_by: "qwen",
    },
    {
      id: "@cf/google/gemma-4-26b-a4b-it",
      object: "model",
      created: 1700000003,
      owned_by: "google",
    },
    {
      id: "@cf/openai/gpt-oss-20b",
      object: "model",
      created: 1700000004,
      owned_by: "openai",
    },
    {
      id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
      object: "model",
      created: 1700000005,
      owned_by: "mistralai",
    },
    {
      id: "@cf/meta/llama-3.1-8b-instruct-awq",
      object: "model",
      created: 1700000006,
      owned_by: "meta",
    },
  ];

  return new Response(
    JSON.stringify({
      object: "list",
      data: models,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json();
    const { model, messages, stream = false } = body;

    if (!model || !messages) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Missing required fields: model, messages",
            type: "invalid_request_error",
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const result = await env.AI.run(model, {
      messages,
      stream,
    });

    if (stream) {
      return new Response(result as ReadableStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: {
          message: error.message || "Internal server error",
          type: "server_error",
        },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
