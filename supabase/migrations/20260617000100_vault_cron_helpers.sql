-- Migration: vault_cron_helpers
-- Creates the private schema, a reusable cron→Edge Function invoker,
-- and the app_config table for runtime constants.
--
-- NOTE: vault.create_secret() calls are NOT here — they live in
-- supabase/vault-setup-MANUAL.sql and must be run via the Supabase
-- Dashboard SQL editor to avoid exposing secret values in Postgres
-- statement logs.

-- ── private schema ──────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS private;

-- ── private.cron_invoke_edge_function ───────────────────────────────────────
-- Reads project_url and service_role_key from Vault, then fires an async
-- HTTP POST via pg_net. Returns the pg_net request_id so the caller can
-- poll net._http_response for the actual response.
--
-- pg_net is in beta; net.http_post returns bigint (request_id) immediately;
-- the response row lands in net._http_response after a short async delay.
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

  -- net.http_post signature: (url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int)
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

-- ── private.app_config ───────────────────────────────────────────────────────
-- Runtime constants that may change without a code deploy (e.g. HF Spaces URL).
CREATE TABLE IF NOT EXISTS private.app_config (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- Placeholder; real URL is set in task 2-2 once the HF Space is provisioned.
INSERT INTO private.app_config (key, value)
VALUES ('HF_SPACES_KEEPWARM_URL', 'https://placeholder.example.com')
ON CONFLICT (key) DO NOTHING;
