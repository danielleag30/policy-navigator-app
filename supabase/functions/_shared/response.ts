/**
 * Shared response envelope module for Policy Navigator Edge Functions.
 *
 * RULE: Every Edge Function must use `success()` or `error()` for EVERY response path.
 *       Raw `{ error: "..." }` or `{ ok: true }` objects are forbidden.
 *
 * Envelope shapes:
 *   SuccessEnvelope<T>  { ok: true; data: T }
 *   ErrorEnvelope       { ok: false; error: { code: ErrorCode; message: string } }
 *
 * Named error codes and their default HTTP status:
 *   RATE_LIMITED      → 429
 *   OLLAMA_EXHAUSTED  → 503
 *   INGESTION_FAILED  → 500
 *   NOT_FOUND         → 404
 *   UNAUTHORIZED      → 401
 */

const JSON_HEADERS: HeadersInit = { "Content-Type": "application/json" };

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
  };
}

export type ErrorCode =
  | "RATE_LIMITED"
  | "OLLAMA_EXHAUSTED"
  | "INGESTION_FAILED"
  | "NOT_FOUND"
  | "UNAUTHORIZED";

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  RATE_LIMITED: 429,
  OLLAMA_EXHAUSTED: 503,
  INGESTION_FAILED: 500,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
};

export function success<T>(data: T): Response {
  const body: SuccessEnvelope<T> = { ok: true, data };
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}

export function error(code: ErrorCode, message: string, status?: number): Response {
  const body: ErrorEnvelope = { ok: false, error: { code, message } };
  return new Response(JSON.stringify(body), {
    status: status ?? DEFAULT_STATUS[code],
    headers: JSON_HEADERS,
  });
}
