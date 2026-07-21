/**
 * Shared Ollama Cloud client module (task 0-9).
 *
 * IMPORTANT — design constraints documented here for all callers:
 *
 * 1. Uses Ollama's native /api/chat endpoint, NOT the OpenAI-compatible /v1/chat/completions.
 *    The OpenAI-compat endpoint has known issues with cloud models.
 *
 * 2. Does NOT pass a `tools` / function-calling parameter. Ollama Cloud returns HTTP 500
 *    when any tools array is provided on cloud-hosted models (confirmed issue).
 *    All LLM extraction uses structured-output prompting within the message content instead.
 *
 * 3. Model is hardcoded to `gemma4:31b-cloud`. No caller should pass a model string.
 *
 * 4. Ollama Cloud deployments should set the Supabase Edge Function secret
 *    `OLLAMA_API_KEY`. When present, requests include `Authorization: Bearer <key>`.
 *    The client still works without the secret for local or unauthenticated endpoints.
 *
 * 5. Temperature is a per-call parameter (not hardcoded). Callers should document their
 *    choice in DEPS.md:
 *      - Extraction tasks (2-4): 0.1 — deterministic structured output
 *      - Temporal Judge (2-9):   0.0 — maximum determinism for filtering decisions
 *      - Answer Drafter (2-11):  0.3 — slight variation acceptable for prose
 *      - Verifier (2-12):        0.0 — must be maximally deterministic
 */

const OLLAMA_MODEL = "gemma4:31b-cloud";
const OLLAMA_EXHAUSTED_MSG =
  "Unable to process your query right now. Please try again in a moment.";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500; // exponential: 500ms, 1000ms, 2000ms

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatResult {
  content: string;
  /** true if all retries were exhausted — caller should surface OLLAMA_EXHAUSTED */
  exhausted?: boolean;
}

/**
 * Send a chat completion request to Ollama Cloud with retry + timeout.
 *
 * @param messages   Conversation messages.
 * @param temperature Sampling temperature (0.0 = deterministic; 1.0 = creative).
 * @param timeoutMsOverride Optional per-call timeout override, in ms. Only the
 *   query-pipeline deep-historical slow path (see
 *   query-pipeline/_deep-historical.ts) passes this — every other caller omits
 *   it and gets the normal OLLAMA_TIMEOUT_MS-derived ceiling (default 15000ms)
 *   unchanged. Never repurpose this to raise the ceiling for the normal path.
 * @returns { content, exhausted? } — never throws; exhausted=true means return OLLAMA_EXHAUSTED_MSG
 */
export async function ollamaChat(
  messages: OllamaMessage[],
  temperature = 0.1,
  timeoutMsOverride?: number,
): Promise<OllamaChatResult> {
  const baseUrl = Deno.env.get("OLLAMA_CLOUD_BASE_URL");
  if (!baseUrl) {
    console.error("[ollama] OLLAMA_CLOUD_BASE_URL not set");
    return { content: OLLAMA_EXHAUSTED_MSG, exhausted: true };
  }

  const timeoutMs = timeoutMsOverride ??
    parseInt(Deno.env.get("OLLAMA_TIMEOUT_MS") ?? "15000", 10);
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/chat`;
  const apiKey = Deno.env.get("OLLAMA_API_KEY");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify({
    model: OLLAMA_MODEL,
    messages,
    stream: false,
    options: { temperature },
    // NOTE: no `tools` key — Ollama Cloud returns 500 when tools are provided
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        console.error(
          `[ollama] HTTP ${resp.status} on attempt ${attempt}: ${
            text.slice(0, 200)
          }`,
        );
        if (attempt < MAX_RETRIES) {
          await _backoff(attempt);
          continue;
        }
        return { content: OLLAMA_EXHAUSTED_MSG, exhausted: true };
      }

      const json = await resp.json() as { message?: { content?: string } };
      const content = json?.message?.content ?? "";
      if (!content) {
        console.error(`[ollama] empty content on attempt ${attempt}`);
        if (attempt < MAX_RETRIES) {
          await _backoff(attempt);
          continue;
        }
        return { content: OLLAMA_EXHAUSTED_MSG, exhausted: true };
      }

      return { content };
    } catch (e) {
      clearTimeout(timer);
      const isTimeout = (e as Error)?.name === "AbortError";
      console.error(
        `[ollama] ${
          isTimeout ? "timeout" : "fetch error"
        } on attempt ${attempt}`,
      );
      if (attempt < MAX_RETRIES) {
        await _backoff(attempt);
        continue;
      }
      return { content: OLLAMA_EXHAUSTED_MSG, exhausted: true };
    }
  }

  // Should not reach here
  return { content: OLLAMA_EXHAUSTED_MSG, exhausted: true };
}

/** Exponential backoff: 500ms * 2^(attempt-1) */
function _backoff(attempt: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, BASE_BACKOFF_MS * Math.pow(2, attempt - 1))
  );
}

/** The clean user-facing exhaustion message — callers should return this verbatim. */
export const OLLAMA_EXHAUSTED = OLLAMA_EXHAUSTED_MSG;
