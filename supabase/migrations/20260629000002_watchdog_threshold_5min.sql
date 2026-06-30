-- Fix: shorten stuck-ingestion watchdog threshold from 30 minutes to 5 minutes.
-- The edge function wall-clock limit is ~150 s; anything processing for > 5 min is dead.

CREATE OR REPLACE FUNCTION private.recover_stuck_ingestions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  stuck_threshold CONSTANT interval := interval '5 minutes';
  rec             record;
BEGIN
  FOR rec IN
    SELECT id, updated_at
    FROM pending_ingestions
    WHERE status = 'processing'
      AND updated_at < now() - stuck_threshold
  LOOP
    UPDATE pending_ingestions
    SET status     = 'pending',
        last_error = 'auto-reset: stuck in processing > 5 min',
        updated_at = now()
    WHERE id = rec.id;

    INSERT INTO pending_alerts (alert_type, details, triggered_at)
    VALUES (
      'ingestion_failure',
      jsonb_build_object(
        'reason',               'stuck_processing',
        'pending_ingestion_id', rec.id,
        'stuck_since',          rec.updated_at
      ),
      now()
    );
  END LOOP;
END;
$$;

-- Re-schedule to run every 5 minutes (was every 30).
SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'stuck-ingestion-recovery-30m';

SELECT cron.schedule(
  'stuck-ingestion-recovery-5m',
  '*/5 * * * *',
  $$ SELECT private.recover_stuck_ingestions(); $$
);
