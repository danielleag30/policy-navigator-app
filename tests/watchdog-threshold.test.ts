// Static source-inspection tests for the stuck-ingestion watchdog threshold.
//
// There is no SQL/pgTAP test harness in this repo, so this verifies the
// follow-up migration that replaces private.recover_stuck_ingestions().

const WATCHDOG_MIGRATION = new URL(
  "../supabase/migrations/20260707010000_watchdog_threshold_10min.sql",
  import.meta.url,
).pathname;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("stuck-ingestion watchdog resets processing rows only after 10 minutes", async () => {
  const src = await Deno.readTextFile(WATCHDOG_MIGRATION);

  assert(
    src.includes("CREATE OR REPLACE FUNCTION private.recover_stuck_ingestions()"),
    "migration must replace the stuck-ingestion watchdog function",
  );
  assert(
    src.includes("stuck_threshold CONSTANT interval := interval '10 minutes';"),
    "watchdog threshold must be 10 minutes",
  );
  assert(
    src.includes("updated_at < now() - stuck_threshold"),
    "watchdog query must use the stuck_threshold constant",
  );
  assert(
    src.includes("WITH reset AS (") &&
      src.includes("UPDATE pending_ingestions") &&
      src.includes("RETURNING id, updated_at AS stuck_since"),
    "watchdog reset must use a single atomic UPDATE ... RETURNING CTE",
  );
  assert(
    !src.includes("FOR rec IN") && !src.includes("LOOP") && !src.includes("WHERE id = rec.id"),
    "watchdog reset must not use a SELECT-then-loop UPDATE pattern",
  );
});

Deno.test("watchdog reset alert text matches the 10-minute threshold", async () => {
  const src = await Deno.readTextFile(WATCHDOG_MIGRATION);

  assert(
    src.includes("last_error = 'auto-reset: stuck in processing > 10 min'"),
    "last_error must report the 10-minute stuck-processing threshold",
  );
  assert(
    src.includes("'reason',               'stuck_processing'"),
    "watchdog alerts must keep the stuck_processing reason",
  );
});
