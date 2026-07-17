-- Schedule the amendment-resolution Edge Function on the same 6-hour cadence as
-- change-detection, using the existing private.cron_invoke_edge_function()
-- helper so URLs, service-role auth, pg_net timeout, and the advisory-lock
-- single-flight guard stay in one place (same pattern as change-detection-6h in
-- 20260623000000_pg_cron_task_2_16.sql).

SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'amendment-resolution-6h';

SELECT cron.schedule(
  'amendment-resolution-6h',
  '30 */6 * * *',
  $$
    SELECT private.cron_invoke_edge_function(
      'amendment-resolution',
      '{}'::jsonb
    );
  $$
);
