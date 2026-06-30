-- Fix pg_cron jobs: remove /functions/v1/ prefix from function_name argument
-- so the URL built by cron_invoke_edge_function is not doubled.

SELECT cron.unschedule(jobid)
  FROM cron.job WHERE jobname = 'change-detection-6h';

SELECT cron.unschedule(jobid)
  FROM cron.job WHERE jobname = 'ingest-orchestrator-poll-15m';

SELECT cron.schedule(
  'change-detection-6h',
  '0 */6 * * *',
  $$
    SELECT private.cron_invoke_edge_function(
      'change-detection',
      '{}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'ingest-orchestrator-poll-15m',
  '*/15 * * * *',
  $$
    SELECT private.cron_invoke_edge_function(
      'ingest-orchestrator',
      '{}'::jsonb
    );
  $$
);
