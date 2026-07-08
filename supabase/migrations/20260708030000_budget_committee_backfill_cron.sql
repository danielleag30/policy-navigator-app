-- Schedule the one-time budget committee historical discovery backfill.
--
-- This uses the existing private.cron_invoke_edge_function() helper so URLs,
-- service-role auth, pg_net timeout, and the advisory-lock guard stay in one
-- place. The wrapper does the cheap database-side completion check first, so
-- once the backfill run is marked complete the 15-minute cron tick does not
-- spend Edge Function compute.

CREATE OR REPLACE FUNCTION private.invoke_budget_committee_backfill_if_needed()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_status text;
  v_queue_remaining int;
BEGIN
  SELECT
    status,
    COALESCE(jsonb_array_length(resume_state->'queue'), 0)
  INTO v_status, v_queue_remaining
  FROM public.discovery_backfill_runs
  WHERE id = 'budget_committee_meeting_historical_2008_2023';

  IF v_status = 'complete' AND v_queue_remaining = 0 THEN
    RAISE NOTICE 'budget_committee_backfill: complete; skipping edge invocation';
    RETURN NULL;
  END IF;

  RETURN private.cron_invoke_edge_function(
    'budget-committee-backfill',
    jsonb_build_object('deadline_ms', 12000)
  );
END;
$$;

SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'budget-committee-backfill-15m';

SELECT cron.schedule(
  'budget-committee-backfill-15m',
  '*/15 * * * *',
  $$ SELECT private.invoke_budget_committee_backfill_if_needed(); $$
);
