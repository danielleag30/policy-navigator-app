// Unit tests for the shared Ollama Cloud client (task 0-9 / DAN-59).
//
// These tests mock globalThis.fetch — no live Ollama Cloud calls are made.
//
// Run with:
//   cd ~/Projects/policy-navigator-app
//   deno test --allow-env tests/ollama-client.test.ts

import { assertEquals, assert } from "jsr:@std/assert@1";

// Set required env vars before importing the module so Deno.env.get() resolves.
Deno.env.set("OLLAMA_CLOUD_BASE_URL", "http://localhost:11434");
// Keep timeout short for tests; the abort-signal test overrides per-case.
Deno.env.set("OLLAMA_TIMEOUT_MS", "5000");
// Use a short base retry delay so backoff tests do not add real wall-clock wait.
Deno.env.set("OLLAMA_RETRY_BASE_MS", "20");

import { ollamaChat } from "../supabase/functions/_shared/ollama-client.ts";

const CLEAN_ERROR =
  "Unable to process your query right now. Please try again in a moment.";

function makeSuccessResponse(content: string): Response {
  return new Response(
    JSON.stringify({ message: { content } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function makeErrorResponse(status = 500): Response {
  return new Response("Internal Server Error", { status });
}

Deno.test("ollamaChat: successful response returns content string", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(makeSuccessResponse("Hello, world!"));
  try {
    const result = await ollamaChat([{ role: "user", content: "Hi" }], 1.0);
    assertEquals(result, "Hello, world!");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("ollamaChat: 3 consecutive failures return clean error string", async () => {
  const original = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = () => {
    callCount++;
    return Promise.resolve(makeErrorResponse(500));
  };
  try {
    // OLLAMA_RETRY_BASE_MS=20ms (set globally above) keeps the total backoff
    // to ~60ms (20ms + 40ms), so this test finishes quickly.
    const result = await ollamaChat([{ role: "user", content: "Test" }], 0.0);
    assertEquals(result, CLEAN_ERROR);
    assertEquals(callCount, 3, "Expected exactly 3 fetch attempts");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("ollamaChat: timeout fires and returns clean error string", async () => {
  const original = globalThis.fetch;
  // Simulate a fetch that never resolves within the timeout window.
  // We set OLLAMA_TIMEOUT_MS to 50ms so the abort fires quickly.
  Deno.env.set("OLLAMA_TIMEOUT_MS", "50");
  globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
    // Return a promise that waits for the abort signal (simulates a slow server).
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) {
        signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError"))
        );
      }
    });
  };
  try {
    const result = await ollamaChat([{ role: "user", content: "Slow" }], 1.0);
    assertEquals(result, CLEAN_ERROR);
  } finally {
    globalThis.fetch = original;
    Deno.env.set("OLLAMA_TIMEOUT_MS", "5000");
  }
});

Deno.test("ollamaChat: retry delays are exponential (each delay doubles)", async () => {
  const original = globalThis.fetch;
  const callTimestamps: number[] = [];
  // Use a very short base (10ms) so the test finishes in ~30ms total.
  Deno.env.set("OLLAMA_RETRY_BASE_MS", "10");
  globalThis.fetch = () => {
    callTimestamps.push(Date.now());
    return Promise.resolve(makeErrorResponse(500));
  };
  try {
    await ollamaChat([{ role: "user", content: "Test" }], 0.0);
    assertEquals(callTimestamps.length, 3, "Expected exactly 3 fetch attempts");
    // Delays: attempt 0 → attempt 1: ~10ms; attempt 1 → attempt 2: ~20ms.
    const gap1 = callTimestamps[1] - callTimestamps[0];
    const gap2 = callTimestamps[2] - callTimestamps[1];
    assert(gap2 > gap1, `Expected second gap (${gap2}ms) > first gap (${gap1}ms) — delays must double`);
  } finally {
    globalThis.fetch = original;
    Deno.env.set("OLLAMA_RETRY_BASE_MS", "20");
  }
});
