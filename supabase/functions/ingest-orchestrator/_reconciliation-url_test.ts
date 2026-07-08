import { reconciliationInvokeUrl } from "./_reconciliation-url.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("reconciliationInvokeUrl targets the deployed `reconciliation` function", () => {
  const url = reconciliationInvokeUrl("https://project-ref.supabase.co");

  assertEquals(url, "https://project-ref.supabase.co/functions/v1/reconciliation");
  if (url.includes("reconcile-ordinances")) {
    throw new Error(
      `URL must not target the never-deployed 'reconcile-ordinances' function: ${url}`,
    );
  }
});
