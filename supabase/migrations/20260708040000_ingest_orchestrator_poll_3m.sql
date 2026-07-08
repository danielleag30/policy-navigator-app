-- Tighten ingest-orchestrator polling from every 15 minutes to every 3 minutes.
-- The job name is intentionally unchanged so existing monitoring/history labels
-- continue to refer to the same scheduled workload.

SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'ingest-orchestrator-poll-15m';

SELECT cron.schedule(
  'ingest-orchestrator-poll-15m',
  '*/3 * * * *',
  $$
    SELECT private.cron_invoke_edge_function(
      'ingest-orchestrator',
      '{}'::jsonb
    );
  $$
);
