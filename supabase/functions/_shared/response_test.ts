import { corsPreflightResponse, error, success } from "./response.ts";

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("success() response includes CORS headers", () => {
  const res = success({ hello: "world" });
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(res.headers.get("Access-Control-Allow-Headers"), "authorization, content-type");
  assertEquals(res.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
});

Deno.test("error() response includes CORS headers on every error code", () => {
  const codes: Array<Parameters<typeof error>[0]> = [
    "RATE_LIMITED",
    "OLLAMA_EXHAUSTED",
    "INGESTION_FAILED",
    "NOT_FOUND",
    "UNAUTHORIZED",
  ];
  for (const code of codes) {
    const res = error(code, "boom");
    assertEquals(
      res.headers.get("Access-Control-Allow-Origin"),
      "*",
      `${code} missing Access-Control-Allow-Origin`,
    );
  }
});

Deno.test("corsPreflightResponse() returns 204 with full CORS header set and no body", async () => {
  const res = corsPreflightResponse();
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(res.headers.get("Access-Control-Allow-Headers"), "authorization, content-type");
  assertEquals(res.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assertEquals(await res.text(), "");
});
