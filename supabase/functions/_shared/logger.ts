/**
 * Structured logger for Supabase Edge Functions.
 *
 * MIGRATION GUIDE — replacing raw console calls:
 *
 * BEFORE:
 *   console.log('[change-detection] Scanning url:', url);
 *   console.warn('[reconciliation] unique constraint hit — skipping');
 *   console.error('[reconciliation] DB insert failed:', err.message);
 *
 * AFTER:
 *   import { logInfo, logWarn, logError, elapsed } from '../_shared/logger.ts';
 *   const start = Date.now();
 *   logInfo('change-detection', 'Scanning url', { url });
 *   logWarn('reconciliation', 'unique constraint hit — skipping', { pair: `(${id1}, ${id2})` });
 *   logError('reconciliation', 'DB insert failed', { code: err.code, message: err.message });
 *   logInfo('change-detection', `completed in ${elapsed(start)}ms`);
 *
 * Rules:
 *   - error level uses console.error (stderr in Supabase logs) but NEVER includes .stack
 *   - meta is omitted from output when not supplied (no trailing `{}`)
 *   - all meta values must be JSON-serializable
 */

export type LogLevel = "info" | "warn" | "error";

export function log(
  level: LogLevel,
  functionName: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  const tag = level.toUpperCase();
  const ts = new Date().toISOString();
  const base = `[${functionName}] [${tag}] ${ts} ${message}`;
  const line = meta !== undefined ? `${base} ${JSON.stringify(meta)}` : base;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(
  fn: string,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  log("info", fn, msg, meta);
}

export function logWarn(
  fn: string,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  log("warn", fn, msg, meta);
}

export function logError(
  fn: string,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  log("error", fn, msg, meta);
}

/** Returns elapsed milliseconds since `start` (where `start = Date.now()`). */
export function elapsed(start: number): number {
  return Date.now() - start;
}
