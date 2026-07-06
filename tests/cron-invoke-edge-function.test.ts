// Tests for private.cron_invoke_edge_function's timeout + single-flight guard
// (fix/cron-http-post-timeout, PR #77).
//
// pg_net's net.http_post() defaulted to a 5s timeout when timeout_milliseconds
// was omitted, while ingest-orchestrator legitimately runs up to its own
// SOFT_DEADLINE_MS (120s) plus margin before the ~150s Edge Function hard
// kill -- pg_net was abandoning the HTTP request at 5s while the invocation
// kept running server-side regardless, producing phantom short-lived
// invocations that competed with the real one for the same free-tier compute
// pool.
//
// An initial fix (private.cron_invocation_locks + a SELECT ... FOR UPDATE /
// INSERT ... ON CONFLICT guard) was replaced after cross-review found it was
// not atomic (a TOCTOU race between concurrent invocations) and depended on
// net._http_response as an indirect, unreliable completion signal. These
// tests verify the current, corrected migration
// (20260706010000_cron_advisory_lock_single_flight.sql) instead.
//
// There is no SQL/pgTAP test harness in this repo, so -- matching the
// established pattern for logic that's easier to verify by inspecting the
// migration source than by spinning up Postgres -- these are static
// source-inspection tests.

const LATEST_MIGRATION = new URL(
  "../supabase/migrations/20260706010000_cron_advisory_lock_single_flight.sql",
  import.meta.url,
).pathname;

const FIRST_MIGRATION = new URL(
  "../supabase/migrations/20260706000000_cron_http_post_timeout_and_single_flight.sql",
  import.meta.url,
).pathname;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("timeout_milliseconds is set to 170000 (above ingest-orchestrator's ~150s hard kill)", async () => {
  const src = await Deno.readTextFile(LATEST_MIGRATION);
  assert(
    src.includes("v_timeout_ms        constant int := 170000;"),
    "v_timeout_ms must be a 170000ms constant",
  );
  assert(
    src.includes("timeout_milliseconds  := v_timeout_ms"),
    "net.http_post must be called with timeout_milliseconds := v_timeout_ms",
  );
});

Deno.test("single-flight guard uses pg_try_advisory_xact_lock, not a lock table", async () => {
  const src = await Deno.readTextFile(LATEST_MIGRATION);
  assert(
    src.includes("pg_try_advisory_xact_lock(hashtext(function_name))"),
    "guard must be an atomic pg_try_advisory_xact_lock keyed on the function_name hash",
  );

  const functionBodyStart = src.indexOf(
    "CREATE OR REPLACE FUNCTION private.cron_invoke_edge_function",
  );
  const functionBodyEnd = src.indexOf("$$;", functionBodyStart) + "$$;".length;
  assert(
    functionBodyStart !== -1 && functionBodyEnd > functionBodyStart,
    "function body not found",
  );
  const functionBody = src.slice(functionBodyStart, functionBodyEnd);

  assert(
    !functionBody.includes("cron_invocation_locks"),
    "the corrected function body must not reference the retired lock table (the DROP TABLE statement after it is expected to)",
  );
});

Deno.test("guard check runs before any vault lookup or net.http_post call, and skips (RETURN NULL) on lock failure", async () => {
  const src = await Deno.readTextFile(LATEST_MIGRATION);
  const guardIdx = src.indexOf("IF NOT pg_try_advisory_xact_lock(hashtext(function_name)) THEN");
  const vaultIdx = src.indexOf("FROM vault.decrypted_secrets");
  const httpPostIdx = src.indexOf("net.http_post(");

  assert(guardIdx !== -1, "advisory-lock guard not found");
  assert(guardIdx < vaultIdx, "the lock must be acquired before any vault secret lookup");
  assert(guardIdx < httpPostIdx, "the lock must be acquired before net.http_post is called");

  const guardBody = src.slice(guardIdx, vaultIdx);
  assert(
    guardBody.includes("RETURN NULL;"),
    "failing to acquire the lock must return NULL immediately without proceeding",
  );
});

Deno.test("follow-up migration drops the retired cron_invocation_locks table", async () => {
  const src = await Deno.readTextFile(LATEST_MIGRATION);
  assert(
    src.includes("DROP TABLE IF EXISTS private.cron_invocation_locks;"),
    "the lock table introduced by the first migration must be dropped",
  );
});

Deno.test("first migration (already applied live) is left intact as history, not edited in place", async () => {
  const src = await Deno.readTextFile(FIRST_MIGRATION);
  assert(
    src.includes("CREATE TABLE IF NOT EXISTS private.cron_invocation_locks"),
    "the original migration file must remain unmodified -- corrections are applied via a follow-up migration, not by rewriting applied history",
  );
});
