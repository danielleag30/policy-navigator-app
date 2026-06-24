import { ollamaChat } from "./ollama-client.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

type FetchCall = {
  input: string | URL | Request;
  init?: RequestInit;
};

const ENV_KEYS = [
  "OLLAMA_CLOUD_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_TIMEOUT_MS",
] as const;

async function withOllamaEnvAndFetch(
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
  const previousEnv = new Map<(typeof ENV_KEYS)[number], string | undefined>();
  const previousFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  for (const key of ENV_KEYS) {
    previousEnv.set(key, Deno.env.get(key));
    if (env[key] === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, env[key]);
    }
  }

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(JSON.stringify({ message: { content: "ok" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  try {
    await fn(calls);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of ENV_KEYS) {
      const previous = previousEnv.get(key);
      if (previous === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, previous);
      }
    }
  }
}

Deno.test("ollamaChat sends bearer auth when OLLAMA_API_KEY is set", async () => {
  await withOllamaEnvAndFetch(
    {
      OLLAMA_CLOUD_BASE_URL: "https://ollama.example/",
      OLLAMA_API_KEY: "test-api-key",
      OLLAMA_TIMEOUT_MS: "15000",
    },
    async (calls) => {
      const result = await ollamaChat([{ role: "user", content: "hello" }], 0.3);

      assertEquals(result, { content: "ok" });
      assertEquals(calls.length, 1);
      assertEquals(String(calls[0].input), "https://ollama.example/api/chat");

      const headers = new Headers(calls[0].init?.headers);
      assertEquals(headers.get("Content-Type"), "application/json");
      assertEquals(headers.get("Authorization"), "Bearer test-api-key");

      const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
      assertEquals(body.model, "gemma4:31b-cloud");
      assertEquals(body.stream, false);
      assertEquals(body.options, { temperature: 0.3 });
      assert(!("tools" in body), "request body must not include tools");
    },
  );
});

Deno.test("ollamaChat omits bearer auth when OLLAMA_API_KEY is absent", async () => {
  await withOllamaEnvAndFetch(
    {
      OLLAMA_CLOUD_BASE_URL: "https://ollama.example",
      OLLAMA_TIMEOUT_MS: "15000",
    },
    async (calls) => {
      const result = await ollamaChat([{ role: "user", content: "hello" }]);

      assertEquals(result, { content: "ok" });
      assertEquals(calls.length, 1);

      const headers = new Headers(calls[0].init?.headers);
      assertEquals(headers.get("Content-Type"), "application/json");
      assertEquals(headers.get("Authorization"), null);
    },
  );
});
