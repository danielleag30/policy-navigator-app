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

// CORS: browsers preflight any cross-origin POST that carries an Authorization
// or Content-Type header, so every response path — success, error, and the
// OPTIONS preflight itself — must carry these or the browser aborts before the
// real request is ever sent.
export const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const JSON_HEADERS: HeadersInit = {
  "Content-Type": "application/json",
  ...CORS_HEADERS,
};

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
