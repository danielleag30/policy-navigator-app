-- Migration: pg_cron jobs for change-detection and ingest-orchestrator
-- Task 2-16: registers two scheduled jobs via the existing
-- private.cron_invoke_edge_function() pattern — no hardcoded URLs or keys.

-- ── Idempotent cleanup ───────────────────────────────────────────────────────
SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'change-detection-6h';

SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'ingest-orchestrator-poll-15m';

-- ── Job 1: Change Detection (every 6 hours) ──────────────────────────────────
SELECT cron.schedule(
  'change-detection-6h',
  '0 */6 * * *',
  $$
    SELECT private.cron_invoke_edge_function(
      'functions/v1/change-detection',
      '{}'::jsonb
    );
  $$
);

-- ── Job 2: Ingestion Orchestrator polling (every 15 minutes) ─────────────────
SELECT cron.schedule(
  'ingest-orchestrator-poll-15m',
  '*/15 * * * *',
  $$
    SELECT private.cron_invoke_edge_function(
      'functions/v1/ingest-orchestrator',
      '{}'::jsonb
    );
  $$
);
