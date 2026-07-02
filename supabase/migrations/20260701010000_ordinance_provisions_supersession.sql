-- Adds the write-side counterpart to the superseded_date the query-pipeline
-- already derives dynamically (query-pipeline/index.ts computeAncestryAndSupersession).
-- Populated by ingest-orchestrator/municode.ts when a re-ingested node's
-- content_hash differs from the existing is_current row for that node
-- (a genuine amendment, not a periodic re-check of unchanged content).

ALTER TABLE ordinance_provisions
  ADD COLUMN IF NOT EXISTS superseded_date date;

CREATE INDEX IF NOT EXISTS ordinance_provisions_superseded_date_idx
  ON ordinance_provisions (superseded_date)
  WHERE superseded_date IS NOT NULL;
