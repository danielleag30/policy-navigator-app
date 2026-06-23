-- Migration: task 2-19 chunk supersession query filter
-- Adds documents.status != 'superseded' JOIN filter to all bm25_* and match_* functions.
-- Re-creates via CREATE OR REPLACE — idempotent.

-- ── BM25 functions ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bm25_ordinance_provisions(
  p_query_text text,
  p_limit      int DEFAULT 40
)
RETURNS SETOF public.ordinance_provisions
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT op.*
  FROM ordinance_provisions op
  JOIN documents d ON d.id = op.document_id
  WHERE op.content_tsv @@ plainto_tsquery('english', p_query_text)
    AND d.status != 'superseded'
  ORDER BY ts_rank(op.content_tsv, plainto_tsquery('english', p_query_text)) DESC
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
  SELECT vt.*
  FROM vote_tallies vt
  JOIN documents d ON d.id = vt.document_id
  WHERE vt.content_tsv @@ plainto_tsquery('english', p_query_text)
    AND d.status != 'superseded'
  ORDER BY ts_rank(vt.content_tsv, plainto_tsquery('english', p_query_text)) DESC
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
  SELECT pd.*
  FROM policy_decisions pd
  JOIN documents d ON d.id = pd.document_id
  WHERE pd.content_tsv @@ plainto_tsquery('english', p_query_text)
    AND d.status != 'superseded'
  ORDER BY ts_rank(pd.content_tsv, plainto_tsquery('english', p_query_text)) DESC
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
  SELECT bi.*
  FROM budget_indicators bi
  JOIN documents d ON d.id = bi.document_id
  WHERE bi.content_tsv @@ plainto_tsquery('english', p_query_text)
    AND d.status != 'superseded'
  ORDER BY ts_rank(bi.content_tsv, plainto_tsquery('english', p_query_text)) DESC
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
  SELECT nc.*
  FROM narrative_chunks nc
  JOIN documents d ON d.id = nc.document_id
  WHERE nc.content_tsv @@ plainto_tsquery('english', p_query_text)
    AND d.status != 'superseded'
  ORDER BY ts_rank(nc.content_tsv, plainto_tsquery('english', p_query_text)) DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.bm25_narrative_chunks(text, int) TO service_role;

-- ── Vector match functions ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.match_ordinance_provisions(
  query_embedding vector(384),
  match_count     int DEFAULT 40
)
RETURNS SETOF public.ordinance_provisions
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT op.*
  FROM ordinance_provisions op
  JOIN documents d ON d.id = op.document_id
  WHERE op.embedding IS NOT NULL
    AND d.status != 'superseded'
  ORDER BY op.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_ordinance_provisions(vector, int) TO service_role;

CREATE OR REPLACE FUNCTION public.match_vote_tallies(
  query_embedding vector(384),
  match_count     int DEFAULT 40
)
RETURNS SETOF public.vote_tallies
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT vt.*
  FROM vote_tallies vt
  JOIN documents d ON d.id = vt.document_id
  WHERE vt.embedding IS NOT NULL
    AND d.status != 'superseded'
  ORDER BY vt.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_vote_tallies(vector, int) TO service_role;

CREATE OR REPLACE FUNCTION public.match_policy_decisions(
  query_embedding vector(384),
  match_count     int DEFAULT 40
)
RETURNS SETOF public.policy_decisions
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT pd.*
  FROM policy_decisions pd
  JOIN documents d ON d.id = pd.document_id
  WHERE pd.embedding IS NOT NULL
    AND d.status != 'superseded'
  ORDER BY pd.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_policy_decisions(vector, int) TO service_role;

CREATE OR REPLACE FUNCTION public.match_budget_indicators(
  query_embedding vector(384),
  match_count     int DEFAULT 40
)
RETURNS SETOF public.budget_indicators
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT bi.*
  FROM budget_indicators bi
  JOIN documents d ON d.id = bi.document_id
  WHERE bi.embedding IS NOT NULL
    AND d.status != 'superseded'
  ORDER BY bi.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_budget_indicators(vector, int) TO service_role;

CREATE OR REPLACE FUNCTION public.match_narrative_chunks(
  query_embedding vector(384),
  match_count     int DEFAULT 40
)
RETURNS SETOF public.narrative_chunks
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT nc.*
  FROM narrative_chunks nc
  JOIN documents d ON d.id = nc.document_id
  WHERE nc.embedding IS NOT NULL
    AND d.status != 'superseded'
  ORDER BY nc.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_narrative_chunks(vector, int) TO service_role;
