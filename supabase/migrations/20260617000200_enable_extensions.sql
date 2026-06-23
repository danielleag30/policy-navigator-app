-- Enable pg_net for async HTTP calls from pg_cron jobs.
-- pg_net is in beta on Supabase; provides net.http_post / net._http_response.
-- Enable pg_cron for scheduled job management.
CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron SCHEMA extensions;
