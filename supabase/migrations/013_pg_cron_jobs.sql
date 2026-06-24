-- Migration 013: pg_cron jobs
-- Keep-warm ping for HF Spaces (pg_net HTTP GET every 24h).
-- Rate-limit bucket cleanup (DELETE rows older than 24h, runs nightly).
-- URL for keep-warm is read from private.app_config at execution time
-- via subquery — never hardcoded.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Job 1: HF Spaces keep-warm (every 24 hours at 06:00 UTC)
SELECT cron.schedule(
  'hf-spaces-keepwarm',
  '0 6 * * *',
  $$
    SELECT net.http_get(
      url := (SELECT value FROM private.app_config WHERE key = 'HF_SPACES_KEEPWARM_URL')
    );
  $$
);

-- Job 2: Rate-limit bucket cleanup (nightly at 03:00 UTC)
SELECT cron.schedule(
  'rate-limit-bucket-cleanup',
  '0 3 * * *',
  $$
    DELETE FROM rate_limit_buckets
    WHERE window_start < now() - interval '24 hours';
  $$
);
