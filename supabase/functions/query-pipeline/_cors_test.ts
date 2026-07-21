/**
 * Tests for the query-pipeline entrypoint's method routing (CORS preflight +
 * POST-only gate). Mirrors the exact branch in index.ts's Deno.serve handler —
 * see rrf_test.ts header for why the full handler isn't imported directly
 * (it requires live env vars and calls Deno.serve as a side effect).
 *
 * Run with:  deno test supabase/functions/query-pipeline/_cors_test.ts
 */

import { corsPreflightResponse, error } from "../_shared/response.ts";

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// Mirrors the top of index.ts's Deno.serve(async (req) => { ... }) handler.
function routeMethod(method: string): Response | "continue" {
  if (method === "OPTIONS") {
    return corsPreflightResponse();
  }
  if (method !== "POST") {
    return error("NOT_FOUND", "Method not allowed", 405);
  }
  return "continue";
}

Deno.test("OPTIONS preflight returns 204 with CORS headers, never reaches the POST-only gate", () => {
  const res = routeMethod("OPTIONS");
  if (res === "continue") throw new Error("OPTIONS must not fall through to the handler body");
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(
    res.headers.get("Access-Control-Allow-Headers"),
    "authorization, content-type, x-admin-secret",
  );
  assertEquals(res.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
});

Deno.test("POST is not rejected — falls through to the real handler body", () => {
  assertEquals(routeMethod("POST"), "continue");
});

Deno.test("GET is rejected with 405 but still carries CORS headers", () => {
  const res = routeMethod("GET");
  if (res === "continue") throw new Error("GET must be rejected");
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("DELETE is rejected with 405 but still carries CORS headers", () => {
  const res = routeMethod("DELETE");
  if (res === "continue") throw new Error("DELETE must be rejected");
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});
