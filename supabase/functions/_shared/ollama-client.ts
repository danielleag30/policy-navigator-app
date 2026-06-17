// Shared Ollama Cloud client for all Policy Navigator Edge Functions.
//
// This is the ONLY module that may call the Ollama API. No Edge Function calls
// the Ollama API directly — they all import and call ollamaChat() from here.
//
// ENDPOINT SELECTION — /api/chat, NOT /v1/chat/completions:
//   Confirmed via GitHub issue: /v1/chat/completions returns 500s on vision
//   models (including gemma4:31b-cloud). The native /api/chat endpoint is the
//   correct and stable path.
//
// NO tools PARAMETER:
//   Confirmed via GitHub issue: passing any `tools` parameter to /api/chat
//   causes 500 errors on cloud models. This pipeline uses plain chat completions
//   with structured-output prompting — never function-calling syntax.
//
// TEMPERATURE:
//   Gemma 4 recommends temperature=1.0 for general use. Callers should override:
//   - Temporal Judge (task 2-9): 0.0–0.3 for determinism
//   - Answer Drafter (task 2-11): 1.0 (default)
//   - Verifier (task 2-12): 0.0–0.3 for determinism
//
// RETRY / TIMEOUT:
//   3 retries with exponential backoff (base × 1, base × 2 — default base 500ms).
//   15-second timeout ceiling, configurable via OLLAMA_TIMEOUT_MS env var.
//   Base retry delay configurable via OLLAMA_RETRY_BASE_MS (default 500ms;
//   set to a small value in tests to avoid real wall-clock wait).
//
// Usage:
//   import { ollamaChat } from "../_shared/ollama-client.ts";
//   const reply = await ollamaChat([{ role: "user", content: "Hello" }], 1.0);

const MODEL = "gemma4:31b-cloud";
const CLEAN_ERROR =
  "Unable to process your query right now. Please try again in a moment.";
const MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;

interface OllamaMessage {
  role: string;
  content: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

async function attemptChat(
  baseUrl: string,
  messages: OllamaMessage[],
  temperature: number,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: false,
        options: { temperature },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}`);
    }

    const json: OllamaChatResponse = await response.json();
    const content = json.message?.content;
    if (!content) {
      throw new Error("Ollama returned empty content");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function ollamaChat(
  messages: Array<{ role: string; content: string }>,
  temperature: number
): Promise<string> {
  const baseUrl = Deno.env.get("OLLAMA_CLOUD_BASE_URL") ?? "";
  const timeoutMs = Number(Deno.env.get("OLLAMA_TIMEOUT_MS") ?? 15000);
  const baseBackoffMs = Number(
    Deno.env.get("OLLAMA_RETRY_BASE_MS") ?? DEFAULT_BASE_BACKOFF_MS
  );

  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, baseBackoffMs * Math.pow(2, attempt - 1))
      );
    }

    try {
      return await attemptChat(baseUrl, messages, temperature, timeoutMs);
    } catch (err) {
      lastError = err;
    }
  }

  // Log internally (no error details exposed to callers).
  console.error("ollamaChat exhausted retries:", lastError);
  return CLEAN_ERROR;
}
