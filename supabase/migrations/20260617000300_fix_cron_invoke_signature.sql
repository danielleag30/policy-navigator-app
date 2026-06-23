-- Fix private.cron_invoke_edge_function: net.http_post takes body as jsonb
-- (not text) per pg_net 0.20.x. This replaces the initial version.
CREATE OR REPLACE FUNCTION private.cron_invoke_edge_function(
  function_name text,
  body          jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_project_url       text;
  v_service_role_key  text;
  v_request_id        bigint;
BEGIN
  SELECT decrypted_secret
    INTO v_project_url
    FROM vault.decrypted_secrets
   WHERE name = 'project_url'
   LIMIT 1;

  SELECT decrypted_secret
    INTO v_service_role_key
    FROM vault.decrypted_secrets
   WHERE name = 'service_role_key'
   LIMIT 1;

  IF v_project_url IS NULL OR v_service_role_key IS NULL THEN
    RAISE EXCEPTION 'Vault secrets not found. Run supabase/vault-setup-MANUAL.sql first.';
  END IF;

  -- net.http_post signature (pg_net 0.20.x):
  --   (url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int)
  SELECT net.http_post(
    url     := v_project_url || '/' || function_name,
    body    := body,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_role_key,
      'Content-Type',  'application/json'
    )
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;
