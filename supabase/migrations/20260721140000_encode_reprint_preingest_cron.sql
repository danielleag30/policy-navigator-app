-- Schedule the recurring encode-reprint-preingest backfill.
--
-- Same shape as invoke_budget_committee_backfill_if_needed()
-- (20260708030000): a cheap database-side completion check runs first, so
-- once every reprint reaches status = 'complete' the 15-minute cron tick
-- stops spending Edge Function compute. Rows are seeded lazily by the
-- function itself (ensureStateRows, sourced from
-- _shared/encode-zoning-reprints.ts) rather than by this migration, so on a
-- fresh deploy encode_reprint_preingest_state starts empty -- the check
-- below only treats that as "skip" once at least one row exists AND none
-- remain incomplete, never on an empty table.
--
-- No deadline_ms override in the invocation body: the function's own
-- DEFAULT_SOFT_DEADLINE_MS (120_000ms, matching ingest-orchestrator's
-- SOFT_DEADLINE_MS convention) is well inside private.cron_invoke_edge_function's
-- 170s pg_net timeout.

CREATE OR REPLACE FUNCTION private.invoke_encode_reprint_preingest_if_needed()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_incomplete_count int;
  v_total_count int;
BEGIN
  SELECT count(*) FILTER (WHERE status <> 'complete'), count(*)
    INTO v_incomplete_count, v_total_count
    FROM public.encode_reprint_preingest_state;

  IF v_total_count > 0 AND v_incomplete_count = 0 THEN
    RAISE NOTICE 'encode-reprint-preingest: all reprints complete; skipping edge invocation';
    RETURN NULL;
  END IF;

  RETURN private.cron_invoke_edge_function(
    'encode-reprint-preingest',
    '{}'::jsonb
  );
END;
$$;

SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'encode-reprint-preingest-15m';

SELECT cron.schedule(
  'encode-reprint-preingest-15m',
  '*/15 * * * *',
  $$ SELECT private.invoke_encode_reprint_preingest_if_needed(); $$
);
