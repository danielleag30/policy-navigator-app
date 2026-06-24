-- Migration: stuck_ingestion_recovery
-- Task 2-17: recovers pending_ingestions rows stuck in 'processing'
-- and writes ingestion_failure alerts.  Runs every 30 minutes via pg_cron.

-- ── Function ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION private.recover_stuck_ingestions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  stuck_threshold CONSTANT interval := interval '30 minutes';
  rec             record;
BEGIN
  FOR rec IN
    SELECT id, updated_at
    FROM pending_ingestions
    WHERE status = 'processing'
      AND updated_at < now() - stuck_threshold
  LOOP
    UPDATE pending_ingestions
    SET status = 'pending'
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

-- ── pg_cron job ───────────────────────────────────────────────────────────────

-- Idempotent cleanup before registering
SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'stuck-ingestion-recovery-30m';

-- Register job: every 30 minutes
SELECT cron.schedule(
  'stuck-ingestion-recovery-30m',
  '*/30 * * * *',
  $$ SELECT private.recover_stuck_ingestions(); $$
);
