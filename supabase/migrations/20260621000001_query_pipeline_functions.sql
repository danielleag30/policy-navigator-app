-- Migration: query pipeline stored functions (task 2-7)
-- Adds three families of functions needed by the query-pipeline Edge Function:
--   1. increment_rate_limit_bucket — atomic upsert-increment for rate limiting
--   2. bm25_{table} — ts_rank-ordered full-text search across each chunk table
--   3. match_{table} — cosine-distance-ordered vector search across each chunk table

-- ── 1. Rate limit bucket — atomic write-or-increment ─────────────────────────

CREATE OR REPLACE FUNCTION public.increment_rate_limit_bucket(
  p_ip_address  text,
  p_window_start timestamptz,
  p_id          uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO rate_limit_buckets (id, ip_address, window_start, request_count, created_at)
  VALUES (p_id, p_ip_address, p_window_start, 1, now())
  ON CONFLICT (ip_address, window_start)
  DO UPDATE SET request_count = rate_limit_buckets.request_count + 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_rate_limit_bucket(text, timestamptz, uuid) TO service_role;

-- ── 2. BM25 search functions (ts_rank-ordered FTS) ───────────────────────────

-- ordinance_provisions
CREATE OR REPLACE FUNCTION public.bm25_ordinance_provisions(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.ordinance_provisions
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM ordinance_provisions
  WHERE content_tsv @@ plainto_tsquery('english', p_query_text)
  ORDER BY ts_rank(content_tsv, plainto_tsquery('english', p_query_text)) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.bm25_ordinance_provisions(text, int) TO service_role;

-- vote_tallies
CREATE OR REPLACE FUNCTION public.bm25_vote_tallies(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.vote_tallies
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM vote_tallies
  WHERE content_tsv @@ plainto_tsquery('english', p_query_text)
  ORDER BY ts_rank(content_tsv, plainto_tsquery('english', p_query_text)) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.bm25_vote_tallies(text, int) TO service_role;

-- policy_decisions
CREATE OR REPLACE FUNCTION public.bm25_policy_decisions(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.policy_decisions
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM policy_decisions
  WHERE content_tsv @@ plainto_tsquery('english', p_query_text)
  ORDER BY ts_rank(content_tsv, plainto_tsquery('english', p_query_text)) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.bm25_policy_decisions(text, int) TO service_role;

-- budget_indicators
CREATE OR REPLACE FUNCTION public.bm25_budget_indicators(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.budget_indicators
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM budget_indicators
  WHERE content_tsv @@ plainto_tsquery('english', p_query_text)
  ORDER BY ts_rank(content_tsv, plainto_tsquery('english', p_query_text)) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.bm25_budget_indicators(text, int) TO service_role;

-- narrative_chunks
CREATE OR REPLACE FUNCTION public.bm25_narrative_chunks(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.narrative_chunks
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM narrative_chunks
  WHERE content_tsv @@ plainto_tsquery('english', p_query_text)
  ORDER BY ts_rank(content_tsv, plainto_tsquery('english', p_query_text)) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.bm25_narrative_chunks(text, int) TO service_role;

-- ── 3. Vector match functions (cosine-distance-ordered HNSW search) ───────────

-- ordinance_provisions
CREATE OR REPLACE FUNCTION public.match_ordinance_provisions(
  query_embedding vector(384),
  match_count     int DEFAULT 40
)
RETURNS SETOF public.ordinance_provisions
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM ordinance_provisions
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_ordinance_provisions(vector, int) TO service_role;

-- vote_tallies
CREATE OR REPLACE FUNCTION public.match_vote_tallies(
  query_embedding vector(384),
  match_count     int DEFAULT 40
)
RETURNS SETOF public.vote_tallies
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM vote_tallies
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_vote_tallies(vector, int) TO service_role;

-- policy_decisions
CREATE OR REPLACE FUNCTION public.match_policy_decisions(
  query_embedding vector(384),
  match_count     int DEFAULT 40
)
RETURNS SETOF public.policy_decisions
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM policy_decisions
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_policy_decisions(vector, int) TO service_role;

-- budget_indicators
CREATE OR REPLACE FUNCTION public.match_budget_indicators(
  query_embedding vector(384),
  match_count     int DEFAULT 40
)
RETURNS SETOF public.budget_indicators
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM budget_indicators
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_budget_indicators(vector, int) TO service_role;

-- narrative_chunks
CREATE OR REPLACE FUNCTION public.match_narrative_chunks(
  query_embedding vector(384),
  match_count     int DEFAULT 40
)
RETURNS SETOF public.narrative_chunks
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT *
  FROM narrative_chunks
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_narrative_chunks(vector, int) TO service_role;
