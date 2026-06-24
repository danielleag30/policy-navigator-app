import {
  elapsed,
  log,
  logError,
  logInfo,
  logWarn,
} from "../supabase/functions/_shared/logger.ts";
import type { LogLevel } from "../supabase/functions/_shared/logger.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureConsole(): {
  lines: Array<{ method: "log" | "warn" | "error"; text: string }>;
  restore: () => void;
} {
  const lines: Array<{ method: "log" | "warn" | "error"; text: string }> = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => lines.push({ method: "log", text: args.join(" ") });
  console.warn = (...args: unknown[]) => lines.push({ method: "warn", text: args.join(" ") });
  console.error = (...args: unknown[]) => lines.push({ method: "error", text: args.join(" ") });

  return {
    lines,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("log('info', ...) outputs [INFO] tag and function name via console.log", () => {
  const cap = captureConsole();
  try {
    log("info", "my-function", "hello world");
    assert(cap.lines.length === 1, "expected exactly one line");
    const { method, text } = cap.lines[0];
    assert(method === "log", `expected console.log, got console.${method}`);
    assert(text.includes("[my-function]"), `missing function name: ${text}`);
    assert(text.includes("[INFO]"), `missing [INFO] tag: ${text}`);
    assert(text.includes("hello world"), `missing message: ${text}`);
  } finally {
    cap.restore();
  }
});

Deno.test("log('warn', ...) outputs [WARN] tag via console.warn", () => {
  const cap = captureConsole();
  try {
    log("warn", "scanner", "slow response");
    assert(cap.lines.length === 1, "expected exactly one line");
    const { method, text } = cap.lines[0];
    assert(method === "warn", `expected console.warn, got console.${method}`);
    assert(text.includes("[WARN]"), `missing [WARN] tag: ${text}`);
    assert(text.includes("[scanner]"), `missing function name: ${text}`);
  } finally {
    cap.restore();
  }
});

Deno.test("log('error', ...) outputs [ERROR] tag via console.error with no stack trace", () => {
  const cap = captureConsole();
  try {
    log("error", "reconciliation", "DB insert failed");
    assert(cap.lines.length === 1, "expected exactly one line");
    const { method, text } = cap.lines[0];
    assert(method === "error", `expected console.error, got console.${method}`);
    assert(text.includes("[ERROR]"), `missing [ERROR] tag: ${text}`);
    assert(!text.includes("at "), `output should not contain stack trace frames: ${text}`);
    assert(!text.includes("Error:"), `output should not contain 'Error:' stack prefix: ${text}`);
  } finally {
    cap.restore();
  }
});

Deno.test("meta object is serialized in output when provided", () => {
  const cap = captureConsole();
  try {
    log("info", "ingest", "chunk stored", { chunkId: "abc-123", size: 42 });
    const { text } = cap.lines[0];
    assert(text.includes('"chunkId"'), `meta key missing: ${text}`);
    assert(text.includes('"abc-123"'), `meta value missing: ${text}`);
    assert(text.includes('"size"'), `meta key missing: ${text}`);
    assert(text.includes("42"), `meta value missing: ${text}`);
  } finally {
    cap.restore();
  }
});

Deno.test("meta is omitted from output when not provided (no trailing {})", () => {
  const cap = captureConsole();
  try {
    log("info", "ingest", "started");
    const { text } = cap.lines[0];
    assert(!text.endsWith("{}"), `output should not end with {}: ${text}`);
    assert(!text.includes("{"), `output should not include braces when meta absent: ${text}`);
  } finally {
    cap.restore();
  }
});

Deno.test("output includes ISO 8601 timestamp", () => {
  const cap = captureConsole();
  try {
    log("info", "fn", "msg");
    const { text } = cap.lines[0];
    // ISO 8601: e.g. 2026-06-22T12:00:00.000Z
    assert(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(text), `missing ISO timestamp: ${text}`);
  } finally {
    cap.restore();
  }
});

Deno.test("elapsed() returns a non-negative number representing milliseconds", () => {
  const start = Date.now();
  const ms = elapsed(start);
  assert(typeof ms === "number", "elapsed() should return a number");
  assert(ms >= 0, "elapsed() should be non-negative");
});

Deno.test("elapsed() reflects actual time passage", async () => {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 10));
  const ms = elapsed(start);
  assert(ms >= 10, `expected at least 10ms, got ${ms}`);
});

Deno.test("logInfo delegates to log with level 'info'", () => {
  const cap = captureConsole();
  try {
    logInfo("my-fn", "info message", { key: "val" });
    assert(cap.lines.length === 1, "expected one line");
    const { method, text } = cap.lines[0];
    assert(method === "log", `logInfo should use console.log, got ${method}`);
    assert(text.includes("[INFO]"), `missing [INFO] tag: ${text}`);
    assert(text.includes("[my-fn]"), `missing fn name: ${text}`);
    assert(text.includes("info message"), `missing message: ${text}`);
    assert(text.includes('"key"'), `missing meta: ${text}`);
  } finally {
    cap.restore();
  }
});

Deno.test("logWarn delegates to log with level 'warn'", () => {
  const cap = captureConsole();
  try {
    logWarn("my-fn", "warn message");
    assert(cap.lines.length === 1, "expected one line");
    const { method, text } = cap.lines[0];
    assert(method === "warn", `logWarn should use console.warn, got ${method}`);
    assert(text.includes("[WARN]"), `missing [WARN] tag: ${text}`);
  } finally {
    cap.restore();
  }
});

Deno.test("logError delegates to log with level 'error' and no stack trace", () => {
  const cap = captureConsole();
  try {
    logError("my-fn", "error message", { code: "23505" });
    assert(cap.lines.length === 1, "expected one line");
    const { method, text } = cap.lines[0];
    assert(method === "error", `logError should use console.error, got ${method}`);
    assert(text.includes("[ERROR]"), `missing [ERROR] tag: ${text}`);
    assert(text.includes('"code"'), `missing meta: ${text}`);
    assert(!text.includes("at "), `should not include stack trace: ${text}`);
  } finally {
    cap.restore();
  }
});

Deno.test("LogLevel type accepts valid values only (compile-time guard via assignment)", () => {
  const levels: LogLevel[] = ["info", "warn", "error"];
  assert(levels.length === 3, "should have three valid log levels");
});
