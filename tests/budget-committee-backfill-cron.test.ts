const MIGRATION = new URL(
  "../supabase/migrations/20260708030000_budget_committee_backfill_cron.sql",
  import.meta.url,
).pathname;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("budget committee backfill cron uses existing edge invocation helper", async () => {
  const src = await Deno.readTextFile(MIGRATION);

  assert(
    src.includes(
      "CREATE OR REPLACE FUNCTION private.invoke_budget_committee_backfill_if_needed()",
    ),
    "migration must define a DB-side wrapper for the cron tick",
  );
  assert(
    src.includes("private.cron_invoke_edge_function(") &&
      src.includes("'budget-committee-backfill'"),
    "cron wrapper must use private.cron_invoke_edge_function for the edge call",
  );
  assert(
    src.includes("jsonb_build_object('deadline_ms', 12000)"),
    "cron invocation must keep each backfill tick bounded",
  );
});

Deno.test("budget committee backfill cron skips edge compute after completion", async () => {
  const src = await Deno.readTextFile(MIGRATION);

  assert(
    src.includes("FROM public.discovery_backfill_runs") &&
      src.includes("budget_committee_meeting_historical_2008_2023"),
    "cron wrapper must inspect the persisted backfill cursor row",
  );
  assert(
    src.includes("v_status = 'complete'") &&
      src.includes("v_queue_remaining = 0") &&
      src.includes("RETURN NULL;"),
    "complete backfill runs must no-op without invoking the edge function",
  );
});

Deno.test("budget committee backfill cron is scheduled every 15 minutes idempotently", async () => {
  const src = await Deno.readTextFile(MIGRATION);

  assert(
    src.includes("cron.unschedule(jobid)") &&
      src.includes("jobname = 'budget-committee-backfill-15m'"),
    "migration must remove any prior copy of the cron job before scheduling",
  );
  assert(
    src.includes("cron.schedule(") &&
      src.includes("'budget-committee-backfill-15m'") &&
      src.includes("'*/15 * * * *'"),
    "backfill cron job must run every 15 minutes",
  );
});
