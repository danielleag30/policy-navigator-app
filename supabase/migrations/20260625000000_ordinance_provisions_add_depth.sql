-- Add parent_node_id and depth columns to ordinance_provisions for recursive Municode ingestion.
-- parent_node_id: the Municode node Id of the parent (null for root/unknown).
-- depth: 0 = TOC root (never inserted), 1 = chapter, 2 = section, 3 = sub-section, etc.

ALTER TABLE ordinance_provisions
  ADD COLUMN IF NOT EXISTS parent_node_id text,
  ADD COLUMN IF NOT EXISTS depth integer;

CREATE INDEX IF NOT EXISTS ordinance_provisions_parent_node_id_idx
  ON ordinance_provisions (parent_node_id)
  WHERE parent_node_id IS NOT NULL;

ALTER TABLE ordinance_provisions
  ADD COLUMN IF NOT EXISTS content_hash text;

CREATE INDEX IF NOT EXISTS ordinance_provisions_content_hash_idx
  ON ordinance_provisions (content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS ordinance_provisions_depth_idx
  ON ordinance_provisions (depth)
  WHERE depth IS NOT NULL;
