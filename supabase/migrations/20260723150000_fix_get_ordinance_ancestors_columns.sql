-- Restore the hierarchy-enrichment RPC that never applied to production.
--
-- The original migration 20260622120000..124252 (get_ordinance_ancestors) selected
-- op.title and op.node_depth from ordinance_provisions, but those columns never existed
-- under those names. The live table exposes `section_title` and `depth` (the `depth` /
-- `parent_node_id` columns were not even added until 20260625/26). Because the June-22
-- function body referenced non-existent columns, the migration errored on push and the RPC
-- was silently absent in prod — every ordinance query degraded (Fable audit, unapplied
-- migration #2).
--
-- The RETURNS TABLE contract (id, municode_node_id, parent_node_id, title, node_depth) is
-- unchanged: the query-pipeline Edge Function reads row.title and row.node_depth, so those
-- output column names are preserved. Only the internal SELECT is corrected to reference the
-- real columns: section_title -> title, depth -> node_depth. Idempotent (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION get_ordinance_ancestors(p_node_ids text[])
RETURNS TABLE(
  id                uuid,
  municode_node_id  text,
  parent_node_id    text,
  title             text,
  node_depth        int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE ancestor_chain AS (
    SELECT op.id, op.municode_node_id, op.parent_node_id,
           op.section_title AS title, op.depth AS node_depth
    FROM ordinance_provisions op
    WHERE op.municode_node_id = ANY(p_node_ids)
    UNION ALL
    SELECT op.id, op.municode_node_id, op.parent_node_id,
           op.section_title AS title, op.depth AS node_depth
    FROM ordinance_provisions op
    JOIN ancestor_chain ac ON op.municode_node_id = ac.parent_node_id
  )
  SELECT DISTINCT id, municode_node_id, parent_node_id, title, node_depth
  FROM ancestor_chain
  ORDER BY node_depth ASC;
$$;

REVOKE ALL ON FUNCTION get_ordinance_ancestors(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_ordinance_ancestors(text[]) TO service_role;
