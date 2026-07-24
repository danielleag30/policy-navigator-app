-- Tighten the HF Spaces keep-warm ping from once daily to every 3 minutes.
--
-- History: 013_pg_cron_jobs.sql scheduled 'hf-spaces-keepwarm' at '0 6 * * *'
-- (daily 06:00 UTC), sized against HF's old 48h sleep timer. The real observed
-- failure mode is different: the free-tier Space
-- (Danielleag30/policy-navigator-docling) goes cold after ~15 min idle, then
-- crash-loops / OOMs on model reload when real load (e.g. the budget re-embed
-- job) suddenly arrives. A daily ping does nothing to prevent that idle-cold
-- cycle. This mirrors PR #88, which tightened ingest-orchestrator polling
-- 15m -> 3m for the same idle-waste reason (see
-- 20260708040000_ingest_orchestrator_poll_3m.sql).
--
-- The job name is intentionally unchanged so existing monitoring / history
-- labels continue to refer to the same scheduled workload.
--
-- Two changes vs. the original command body:
--   1. Schedule: '0 6 * * *' -> '*/3 * * * *'.
--   2. Add an explicit timeout_milliseconds to net.http_get. The original call
--      passed none, so pg_net fell back to its 5s default — the same
--      missing-timeout class of bug PR #77 fixed on net.http_post
--      (20260706000000_cron_http_post_timeout_and_single_flight.sql). A cold
--      Space can take longer than 5s to answer /health while it spins back up;
--      15000ms gives it a reasonable window without ever waiting indefinitely.
--
-- The URL is still read from private.app_config at execution time and already
-- points at the real Space health endpoint
-- (https://danielleag30-policy-navigator-docling.hf.space/health, a genuine
-- FastAPI GET /health route returning {"ok": true}), so no URL change is needed.

SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'hf-spaces-keepwarm';

SELECT cron.schedule(
  'hf-spaces-keepwarm',
  '*/3 * * * *',
  $$
    SELECT net.http_get(
      url                  := (SELECT value FROM private.app_config WHERE key = 'HF_SPACES_KEEPWARM_URL'),
      timeout_milliseconds := 15000
    );
  $$
);
