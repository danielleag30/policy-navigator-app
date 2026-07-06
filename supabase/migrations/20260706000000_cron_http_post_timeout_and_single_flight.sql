-- Fix private.cron_invoke_edge_function: net.http_post was called without
-- timeout_milliseconds, so pg_net fell back to its 5s default. ingest-orchestrator
-- legitimately runs up to its own SOFT_DEADLINE_MS (120_000ms, see
-- supabase/functions/ingest-orchestrator/index.ts) plus a further margin before
-- the ~150s Edge Function hard kill. pg_net was abandoning the HTTP request at
-- 5s while the invocation kept running server-side regardless, producing
-- phantom short-lived invocations that compete with the real one for the same
-- free-tier compute pool.
--
-- Also adds a single-flight guard: skip firing a new invocation for a given
-- function_name while a previous one's request is still outstanding (no
-- response row yet in net._http_response, and still inside its timeout
-- window). Defense-in-depth alongside the explicit timeout above, in case a
-- retry/backoff path ever races a fresh cron tick for the same function.

CREATE TABLE IF NOT EXISTS private.cron_invocation_locks (
  function_name text PRIMARY KEY,
  request_id    bigint,
  invoked_at    timestamptz NOT NULL DEFAULT now()
);

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
  -- ingest-orchestrator's own SOFT_DEADLINE_MS is 120_000ms, with a ~150s
  -- hard kill; 170_000ms gives pg_net a window at least as long as the
  -- function is designed to run, plus margin, while still eventually
  -- giving up rather than waiting forever.
  v_timeout_ms        constant int := 170000;
  v_prior_request_id  bigint;
  v_prior_invoked_at  timestamptz;
  v_prior_responded   boolean;
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

  SELECT l.request_id, l.invoked_at
    INTO v_prior_request_id, v_prior_invoked_at
    FROM private.cron_invocation_locks l
   WHERE l.function_name = cron_invoke_edge_function.function_name
     FOR UPDATE;

  IF FOUND AND v_prior_request_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM net._http_response r WHERE r.id = v_prior_request_id
    ) INTO v_prior_responded;

    IF NOT v_prior_responded
       AND now() < v_prior_invoked_at + make_interval(secs => v_timeout_ms / 1000.0)
    THEN
      RAISE NOTICE 'cron_invoke_edge_function: skipping % — prior invocation (request_id %) still outstanding since %',
        function_name, v_prior_request_id, v_prior_invoked_at;
      RETURN NULL;
    END IF;
  END IF;

  -- net.http_post signature (pg_net 0.20.x):
  --   (url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int)
  SELECT net.http_post(
    url                   := v_project_url || '/' || function_name,
    body                  := body,
    headers               := jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_role_key,
      'Content-Type',  'application/json'
    ),
    timeout_milliseconds  := v_timeout_ms
  ) INTO v_request_id;

  INSERT INTO private.cron_invocation_locks (function_name, request_id, invoked_at)
  VALUES (function_name, v_request_id, now())
  ON CONFLICT (function_name) DO UPDATE
    SET request_id = EXCLUDED.request_id,
        invoked_at = EXCLUDED.invoked_at;

  RETURN v_request_id;
END;
$$;
