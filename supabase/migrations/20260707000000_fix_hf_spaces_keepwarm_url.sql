-- Migration: fix_hf_spaces_keepwarm_url
--
-- 20260617000100_vault_cron_helpers.sql seeded private.app_config with a
-- literal placeholder ('https://placeholder.example.com') for
-- HF_SPACES_KEEPWARM_URL, to be replaced once the HF Space was provisioned
-- (task 2-2). No migration ever recorded that replacement, so the pg_cron
-- 'hf-spaces-keepwarm' job (013_pg_cron_jobs.sql, daily 06:00 UTC) would
-- ping the placeholder on any environment rebuilt from migrations.
--
-- Point it at the real Docling Space health endpoint (see
-- HF_SPACES_DOCLING_URL in .env.local.example).
UPDATE private.app_config
SET value = 'https://danielleag30-policy-navigator-docling.hf.space/health'
WHERE key = 'HF_SPACES_KEEPWARM_URL';
