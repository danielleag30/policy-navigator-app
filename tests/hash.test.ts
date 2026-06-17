// Unit tests for the shared content_hash utility (task 0-10 / DAN-60).
//
// Run with:
//   cd ~/Projects/policy-navigator-app
//   deno test --allow-env tests/hash.test.ts

import { assertEquals, assert } from "jsr:@std/assert@1";

import { contentHash } from "../supabase/functions/_shared/hash.ts";

// Standard SHA-256("hello") vector, verified against multiple independent sources.
const SHA256_HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

Deno.test("contentHash: known SHA-256 vector for 'hello'", async () => {
  const result = await contentHash("hello");
  assertEquals(result, SHA256_HELLO);
});

Deno.test("contentHash: empty string produces a valid 64-char hex string", async () => {
  const result = await contentHash("");
  assert(result.length === 64, `Expected 64-char hex, got ${result.length} chars`);
  assert(/^[0-9a-f]{64}$/.test(result), `Expected lowercase hex, got: ${result}`);
});

Deno.test("contentHash: same input always produces the same output (determinism)", async () => {
  const input = "policy document content for determinism check";
  const first = await contentHash(input);
  const second = await contentHash(input);
  assertEquals(first, second, "contentHash must be deterministic");
  assert(first.length === 64, "Output must be 64-char hex");
});
