-- Fix BM25 natural-language query construction.
--
-- The BM25 RPCs previously used plainto_tsquery('english', ...), which ANDs all
-- plain query terms together. Multi-word natural-language retrieval queries can
-- therefore return zero candidates even when relevant chunks contain some of the
-- terms. Keep the english dictionary and existing ranking/limit behavior, but
-- construct the tsquery with websearch_to_tsquery using explicit web-search OR
-- operators between raw query terms.

CREATE OR REPLACE FUNCTION public.bm25_ordinance_provisions(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.ordinance_provisions
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM ordinance_provisions
  WHERE content_tsv @@ websearch_to_tsquery('english', regexp_replace(trim(p_query_text), '[[:space:]]+', ' OR ', 'g'))
  ORDER BY ts_rank(content_tsv, websearch_to_tsquery('english', regexp_replace(trim(p_query_text), '[[:space:]]+', ' OR ', 'g'))) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.bm25_ordinance_provisions(text, int) TO service_role;

CREATE OR REPLACE FUNCTION public.bm25_vote_tallies(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.vote_tallies
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM vote_tallies
  WHERE content_tsv @@ websearch_to_tsquery('english', regexp_replace(trim(p_query_text), '[[:space:]]+', ' OR ', 'g'))
  ORDER BY ts_rank(content_tsv, websearch_to_tsquery('english', regexp_replace(trim(p_query_text), '[[:space:]]+', ' OR ', 'g'))) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.bm25_vote_tallies(text, int) TO service_role;

CREATE OR REPLACE FUNCTION public.bm25_policy_decisions(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.policy_decisions
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM policy_decisions
  WHERE content_tsv @@ websearch_to_tsquery('english', regexp_replace(trim(p_query_text), '[[:space:]]+', ' OR ', 'g'))
  ORDER BY ts_rank(content_tsv, websearch_to_tsquery('english', regexp_replace(trim(p_query_text), '[[:space:]]+', ' OR ', 'g'))) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.bm25_policy_decisions(text, int) TO service_role;

CREATE OR REPLACE FUNCTION public.bm25_budget_indicators(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.budget_indicators
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM budget_indicators
  WHERE content_tsv @@ websearch_to_tsquery('english', regexp_replace(trim(p_query_text), '[[:space:]]+', ' OR ', 'g'))
  ORDER BY ts_rank(content_tsv, websearch_to_tsquery('english', regexp_replace(trim(p_query_text), '[[:space:]]+', ' OR ', 'g'))) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.bm25_budget_indicators(text, int) TO service_role;

CREATE OR REPLACE FUNCTION public.bm25_narrative_chunks(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.narrative_chunks
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM narrative_chunks
  WHERE content_tsv @@ websearch_to_tsquery('english', regexp_replace(trim(p_query_text), '[[:space:]]+', ' OR ', 'g'))
  ORDER BY ts_rank(content_tsv, websearch_to_tsquery('english', regexp_replace(trim(p_query_text), '[[:space:]]+', ' OR ', 'g'))) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.bm25_narrative_chunks(text, int) TO service_role;
