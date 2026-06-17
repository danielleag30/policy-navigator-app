// Unit tests for the shared response envelope module (task 0-11 / DAN-61).
//
// Run with:
//   cd ~/Projects/policy-navigator-app
//   deno test --allow-env tests/response.test.ts

import { assertEquals } from "jsr:@std/assert@1";

import { success, error } from "../supabase/functions/_shared/response.ts";

Deno.test("success: status 200 with SuccessEnvelope body", async () => {
  const res = success({ id: 1 });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { ok: true, data: { id: 1 } });
});

Deno.test("error NOT_FOUND: status 404 with ErrorEnvelope body", async () => {
  const res = error("NOT_FOUND", "Document not found");
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body, {
    ok: false,
    error: { code: "NOT_FOUND", message: "Document not found" },
  });
});

Deno.test("error RATE_LIMITED with non-default status override: override takes effect", async () => {
  const res = error("RATE_LIMITED", "Too many requests", 418);
  assertEquals(res.status, 418);
  const body = await res.json();
  assertEquals(body, {
    ok: false,
    error: { code: "RATE_LIMITED", message: "Too many requests" },
  });
});

Deno.test("error OLLAMA_EXHAUSTED: default status 503", async () => {
  const res = error("OLLAMA_EXHAUSTED", "LLM unavailable");
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body, {
    ok: false,
    error: { code: "OLLAMA_EXHAUSTED", message: "LLM unavailable" },
  });
});

Deno.test("Content-Type is application/json on success response", () => {
  const res = success({ x: 1 });
  assertEquals(res.headers.get("Content-Type"), "application/json");
});

Deno.test("Content-Type is application/json on error response", () => {
  const res = error("UNAUTHORIZED", "Forbidden");
  assertEquals(res.headers.get("Content-Type"), "application/json");
});
