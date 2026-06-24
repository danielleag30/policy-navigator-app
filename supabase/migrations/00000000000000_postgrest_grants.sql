-- PostgREST grants for projects created after 2026-05-30.
-- These explicit grants are required; Supabase no longer applies implicit public grants.
--
-- Security posture:
--   anon          → schema USAGE only. No table-level SELECT/INSERT/UPDATE/DELETE, ever.
--   authenticated → schema USAGE only. Table grants are added per Phase 1 migration task.
--   service_role  → full privileges by default; bypasses RLS. Used exclusively by Edge Functions.
--
-- The frontend never queries Postgres via PostgREST with the anon key.
-- All runtime database access goes through Edge Functions (service role key).
--
-- RLS standard for every Phase 1 migration (tasks 1-1 through 1-10):
--   After CREATE TABLE, before indexes:
--     ALTER TABLE <table_name> ENABLE ROW LEVEL SECURITY;
--   anon receives no permissive RLS policies at any point in the build.
--   This file establishes that pattern; per-table enablement is in each Phase 1 migration.

GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
