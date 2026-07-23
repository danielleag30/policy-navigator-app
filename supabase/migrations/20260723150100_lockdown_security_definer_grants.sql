-- Fable audit finding S-1: SECURITY DEFINER RPCs (bm25_*, match_*,
-- increment_rate_limit_bucket, ping) were created with EXECUTE granted to PUBLIC, and
-- carried explicit anon / authenticated EXECUTE grants. Because they run as the definer
-- (owner) and bypass RLS, an unauthenticated caller could invoke them directly against the
-- PostgREST endpoint. Fable proved an anon caller could WRITE via increment_rate_limit_bucket
-- (it performs an INSERT/UPSERT) and could probe the retrieval RPCs at will.
--
-- These functions are only ever called by the query-pipeline Edge Function, which uses the
-- service_role key. Lock every one of them down to service_role only. Revoking from PUBLIC
-- (the implicit "" grant) removes the default EXECUTE that a bare CREATE FUNCTION confers, so
-- future re-creates without an explicit grant stay closed too.
--
-- Signatures enumerated from live pg_proc. Idempotent: REVOKE/GRANT are safe to re-run.

REVOKE EXECUTE ON FUNCTION public.bm25_budget_indicators(text, integer)                                  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bm25_narrative_chunks(text, integer)                                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bm25_ordinance_provisions(text, integer)                               FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bm25_policy_decisions(text, integer)                                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bm25_vote_tallies(text, integer)                                       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.match_budget_indicators(vector, integer)                               FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.match_narrative_chunks(vector, integer)                                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.match_ordinance_provisions(vector, integer)                            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.match_policy_decisions(vector, integer)                                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.match_vote_tallies(vector, integer)                                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_rate_limit_bucket(text, timestamp with time zone, uuid)      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ping()                                                                 FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.bm25_budget_indicators(text, integer)                                   TO service_role;
GRANT EXECUTE ON FUNCTION public.bm25_narrative_chunks(text, integer)                                    TO service_role;
GRANT EXECUTE ON FUNCTION public.bm25_ordinance_provisions(text, integer)                                TO service_role;
GRANT EXECUTE ON FUNCTION public.bm25_policy_decisions(text, integer)                                    TO service_role;
GRANT EXECUTE ON FUNCTION public.bm25_vote_tallies(text, integer)                                        TO service_role;
GRANT EXECUTE ON FUNCTION public.match_budget_indicators(vector, integer)                                TO service_role;
GRANT EXECUTE ON FUNCTION public.match_narrative_chunks(vector, integer)                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.match_ordinance_provisions(vector, integer)                             TO service_role;
GRANT EXECUTE ON FUNCTION public.match_policy_decisions(vector, integer)                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.match_vote_tallies(vector, integer)                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_rate_limit_bucket(text, timestamp with time zone, uuid)       TO service_role;
GRANT EXECUTE ON FUNCTION public.ping()                                                                  TO service_role;
