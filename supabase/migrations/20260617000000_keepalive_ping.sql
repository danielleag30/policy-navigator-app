-- Trivial health-check function used by the keepalive-health Edge Function.
-- Called via supabase.rpc('ping') with the service-role client to confirm
-- PostgREST → Postgres connectivity on each GitHub Actions keep-alive run.
-- SECURITY DEFINER is safe here: the function contains no privileged logic.
CREATE OR REPLACE FUNCTION public.ping()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
AS $$ SELECT true; $$;
