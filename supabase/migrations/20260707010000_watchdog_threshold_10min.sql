-- Fix: give legitimate long-running ingest-orchestrator invocations more
-- headroom before the stuck-ingestion watchdog resets processing rows.
-- The cron job still runs every 5 minutes; rows are only reset after 10 minutes
-- in processing.

CREATE OR REPLACE FUNCTION private.recover_stuck_ingestions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  stuck_threshold CONSTANT interval := interval '10 minutes';
BEGIN
  WITH reset AS (
    UPDATE pending_ingestions
    SET status     = 'pending',
        last_error = 'auto-reset: stuck in processing > 10 min',
        updated_at = now()
    WHERE status = 'processing'
      AND updated_at < now() - stuck_threshold
    RETURNING id, updated_at AS stuck_since
  )
  INSERT INTO pending_alerts (alert_type, details, triggered_at)
  SELECT
    'ingestion_failure',
    jsonb_build_object(
      'reason',               'stuck_processing',
      'pending_ingestion_id', id,
      'stuck_since',          stuck_since
    ),
    now()
  FROM reset;
END;
$$;
