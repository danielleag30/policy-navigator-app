-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  MANUAL VAULT SETUP — DO NOT RUN VIA `supabase db push`               ║
-- ║                                                                        ║
-- ║  Run this ONLY via the Supabase Dashboard SQL editor or via:           ║
-- ║    supabase db execute --project-ref ahaurkifxzqsrhwjshbj \           ║
-- ║      --file supabase/vault-setup-MANUAL.sql                           ║
-- ║                                                                        ║
-- ║  WHY: vault.create_secret() passes secret values as SQL literals.     ║
-- ║  If run inside a tracked migration, the values will appear in          ║
-- ║  Postgres statement logs (pg_stat_statements, log_statement=all,      ║
-- ║  Supabase dashboard query history, etc.).                              ║
-- ║                                                                        ║
-- ║  This file IS committed to git as documentation of the required        ║
-- ║  calls, but the actual secret values are substituted at run time       ║
-- ║  by the operator — NOT hardcoded here.                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Replace the values below with real secrets before running.
-- These are the two secrets consumed by private.cron_invoke_edge_function().

SELECT vault.create_secret(
  'https://ahaurkifxzqsrhwjshbj.supabase.co/functions/v1',
  'project_url',
  'Base URL for Edge Function invocations from pg_cron'
);

-- IMPORTANT: substitute your actual SUPABASE_SERVICE_ROLE_KEY here.
-- Do NOT commit this file after filling in the key.
SELECT vault.create_secret(
  'REPLACE_WITH_SUPABASE_SERVICE_ROLE_KEY',
  'service_role_key',
  'Service-role JWT for authorising pg_cron → Edge Function calls'
);

-- Verify both secrets were stored (shows names only, never decrypted values):
SELECT id, name, description, created_at
  FROM vault.secrets
 WHERE name IN ('project_url', 'service_role_key');
