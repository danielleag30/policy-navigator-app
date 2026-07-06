-- Cross-review of #77 found the cron_invocation_locks table's guard
-- (SELECT ... FOR UPDATE followed by a separate INSERT ... ON CONFLICT) was
-- not atomic: two concurrent invocations of cron_invoke_edge_function for the
-- same function_name could both read "no lock" / "stale lock" and both pass
-- the check before either committed its INSERT, defeating the guard. Its
-- release signal (a response row landing in net._http_response) was also an
-- indirect proxy for "the prior request is done," dependent on pg_net's own
-- async bookkeeping rather than a direct guarantee.
--
-- Replaces both with pg_try_advisory_xact_lock(hashtext(function_name)): a
-- single atomic, non-blocking call scoped to the invoking transaction, with
-- no separate read-then-write step and thus no TOCTOU window. A concurrent
-- invocation for the same function_name that can't acquire the lock returns
-- false immediately (rather than blocking) and is skipped, matching the
-- existing behavior. The lock is released automatically when the calling
-- transaction ends, so it guards concurrent SQL-level invocations of this
-- function (e.g. an overlapping retry/backoff firing alongside a scheduled
-- cron tick) -- not the full duration of the async HTTP round-trip, which
-- pg_net performs after this function's transaction has already committed.
--
-- The lock table is no longer needed.

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
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext(function_name)) THEN
    RAISE NOTICE 'cron_invoke_edge_function: skipping % — another invocation is already in flight',
      function_name;
    RETURN NULL;
  END IF;

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
    url                   := v_project_url || '/' || function_name,
    body                  := body,
    headers               := jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_role_key,
      'Content-Type',  'application/json'
    ),
    timeout_milliseconds  := v_timeout_ms
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

DROP TABLE IF EXISTS private.cron_invocation_locks;
