-- BM25 natural-language recall: switch the five bm25_* RPCs from AND to OR semantics.
--
-- Background. plainto_tsquery('english', q) joins every stemmed content term with `&`
-- (AND), so the full natural-language question the query-pipeline passes verbatim
-- (index.ts: bm25ForTable(t, query), query = body.query.trim()) only matches a row that
-- contains ALL terms. For real multi-word questions that almost never happens.
--
-- This is NOT the dictionary bug. Migration 20260622120001 already standardized every
-- content_tsv to the 'english' config that these functions query with, and that fix is
-- live (bm25_ordinance_provisions('transient occupancy tax rate') returns 3 rows). This
-- migration addresses a SEPARATE, independently-measured defect that persists AFTER the
-- dictionary fix.
--
-- Measurement (2026-07-23, live index, 156 eval-case questions passed verbatim through the
-- live bm25_* functions as-is, checking whether each gold chunk lands in the top-40 the RPC
-- returns — CANDIDATE_COUNT=40):
--   AND (current, plainto_tsquery)      OR (this migration, OR-injected)
--   0 BM25 rows returned : 88 / 156 (56%)     zero-row cases eliminated wherever any term matches
--   gold in top-40       : 19 / 156 (12%)  -> 56 / 156 (36%)
--   gold in top-10       : 16 / 156 (10%)  -> 28 / 156 (18%)
--   recall gained by OR  : 38 cases        recall lost by OR: 1 case (net +37; no top-10 regression)
--   websearch_to_tsquery : returns the SAME 0 rows as AND on every measured zero-row case
--                          (it still ANDs terms) — so it is NOT the fix.
--
-- Construction. We take the stemmed lexeme set plainto_tsquery already produces (tokenized,
-- stemmed, stop-words removed, punctuation handled) and flip the connective `&` -> `|`.
-- plainto_tsquery output only ever contains `&` between lexemes, so a textual replace yields
-- exactly the OR-of-lexemes query and nothing else. This is more robust than OR-injecting raw
-- whitespace-split tokens before stemming (the superseded PR #126 approach), which mangles
-- punctuation-attached tokens and any literal AND/OR words in the query.
--
-- ts_rank ordering + LIMIT p_limit still cap output at the top p_limit rows, so the wider OR
-- match set never leaves the function; measured top-10 precision improved, not regressed.
--
-- IMPORTANT — preserves the live definition. The live bodies (from pg_proc) JOIN documents and
-- filter `d.status <> 'superseded'`; that join is NOT in the source migration 20260621000001
-- (live has drifted ahead of source). We reproduce the full live body here so this migration
-- both applies the recall fix AND re-captures the drifted definition in source control. PR #126,
-- written against the pre-join source body, would have silently reverted the superseded filter.
--
-- Grants: CREATE OR REPLACE preserves the existing ACL, and migration 20260723150100 locked
-- these to service_role only. We re-assert the lockdown at the end so this migration cannot
-- widen access. Held for post-review; NOT applied to production.

-- ordinance_provisions
CREATE OR REPLACE FUNCTION public.bm25_ordinance_provisions(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.ordinance_provisions
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH q AS (
    SELECT replace(plainto_tsquery('english', p_query_text)::text, '&', '|')::tsquery AS ts
  )
  SELECT op.*
  FROM ordinance_provisions op
  JOIN documents d ON d.id = op.document_id
  CROSS JOIN q
  WHERE op.content_tsv @@ q.ts
    AND d.status != 'superseded'
  ORDER BY ts_rank(op.content_tsv, q.ts) DESC
  LIMIT p_limit;
$$;

-- vote_tallies
CREATE OR REPLACE FUNCTION public.bm25_vote_tallies(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.vote_tallies
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH q AS (
    SELECT replace(plainto_tsquery('english', p_query_text)::text, '&', '|')::tsquery AS ts
  )
  SELECT vt.*
  FROM vote_tallies vt
  JOIN documents d ON d.id = vt.document_id
  CROSS JOIN q
  WHERE vt.content_tsv @@ q.ts
    AND d.status != 'superseded'
  ORDER BY ts_rank(vt.content_tsv, q.ts) DESC
  LIMIT p_limit;
$$;

-- policy_decisions
CREATE OR REPLACE FUNCTION public.bm25_policy_decisions(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.policy_decisions
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH q AS (
    SELECT replace(plainto_tsquery('english', p_query_text)::text, '&', '|')::tsquery AS ts
  )
  SELECT pd.*
  FROM policy_decisions pd
  JOIN documents d ON d.id = pd.document_id
  CROSS JOIN q
  WHERE pd.content_tsv @@ q.ts
    AND d.status != 'superseded'
  ORDER BY ts_rank(pd.content_tsv, q.ts) DESC
  LIMIT p_limit;
$$;

-- budget_indicators
CREATE OR REPLACE FUNCTION public.bm25_budget_indicators(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.budget_indicators
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH q AS (
    SELECT replace(plainto_tsquery('english', p_query_text)::text, '&', '|')::tsquery AS ts
  )
  SELECT bi.*
  FROM budget_indicators bi
  JOIN documents d ON d.id = bi.document_id
  CROSS JOIN q
  WHERE bi.content_tsv @@ q.ts
    AND d.status != 'superseded'
  ORDER BY ts_rank(bi.content_tsv, q.ts) DESC
  LIMIT p_limit;
$$;

-- narrative_chunks
CREATE OR REPLACE FUNCTION public.bm25_narrative_chunks(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.narrative_chunks
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH q AS (
    SELECT replace(plainto_tsquery('english', p_query_text)::text, '&', '|')::tsquery AS ts
  )
  SELECT nc.*
  FROM narrative_chunks nc
  JOIN documents d ON d.id = nc.document_id
  CROSS JOIN q
  WHERE nc.content_tsv @@ q.ts
    AND d.status != 'superseded'
  ORDER BY ts_rank(nc.content_tsv, q.ts) DESC
  LIMIT p_limit;
$$;

-- Re-assert the S-1 lockdown (idempotent) so this rework cannot widen access.
REVOKE EXECUTE ON FUNCTION public.bm25_budget_indicators(text, integer)     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bm25_narrative_chunks(text, integer)      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bm25_ordinance_provisions(text, integer)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bm25_policy_decisions(text, integer)      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bm25_vote_tallies(text, integer)          FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.bm25_budget_indicators(text, integer)      TO service_role;
GRANT EXECUTE ON FUNCTION public.bm25_narrative_chunks(text, integer)       TO service_role;
GRANT EXECUTE ON FUNCTION public.bm25_ordinance_provisions(text, integer)   TO service_role;
GRANT EXECUTE ON FUNCTION public.bm25_policy_decisions(text, integer)       TO service_role;
GRANT EXECUTE ON FUNCTION public.bm25_vote_tallies(text, integer)           TO service_role;
