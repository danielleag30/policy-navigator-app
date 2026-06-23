-- Migration: CP-2 remediation — add supersession filter to get_ordinance_ancestors.
-- Missed by task 2-19; applies the same documents.status != 'superseded' JOIN pattern.
-- Re-creates via CREATE OR REPLACE — idempotent.

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
    SELECT op.id, op.municode_node_id, op.parent_node_id, op.title, op.node_depth
    FROM ordinance_provisions op
    JOIN documents d ON d.id = op.document_id
    WHERE op.municode_node_id = ANY(p_node_ids)
      AND d.status != 'superseded'
    UNION ALL
    SELECT op.id, op.municode_node_id, op.parent_node_id, op.title, op.node_depth
    FROM ordinance_provisions op
    JOIN documents d ON d.id = op.document_id
    JOIN ancestor_chain ac ON op.municode_node_id = ac.parent_node_id
    WHERE d.status != 'superseded'
  )
  SELECT DISTINCT id, municode_node_id, parent_node_id, title, node_depth
  FROM ancestor_chain
  ORDER BY node_depth ASC;
$$;

REVOKE ALL ON FUNCTION get_ordinance_ancestors(text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION get_ordinance_ancestors(text[]) TO service_role;
