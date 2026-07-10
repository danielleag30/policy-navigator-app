-- Adds EnCode zoning-ordinance ingestion as a new source alongside Municode.
--
-- Fairfax County's Zoning Ordinance (Chapter 112.2) is NOT on Municode (product
-- 10051 jumps from Chapter 110 to Chapter 113) -- it is published on a separate
-- codification platform, EnCode (https://online.encodeplus.com/regs/fairfaxcounty-va/).
-- See supabase/functions/ingest-orchestrator/encode.ts for the ingestion walk.
--
-- Schema choices:
--   1. doc_type CHECK constraints (documents, pending_ingestions) gain
--      'encode_zoning' alongside the existing five values.
--   2. ordinance_provisions gains a source_type discriminator rather than a
--      new table -- the row shape (versioned node content, is_current,
--      supersession, embedding) is identical to Municode's. EnCode node ids
--      (small integers, e.g. "2557") are stored in the existing
--      municode_node_id column PREFIXED with "encode:" (e.g. "encode:2557")
--      to keep them in a disjoint value space from real Municode node ids --
--      the column is reused as-is (not renamed) to avoid touching every
--      existing consumer (query-pipeline, get_ordinance_ancestors, admin
--      views) that already reads/filters on it.
--   3. documents gains encode_resume_state (jsonb) as a dedicated column,
--      parallel to municode_resume_state -- kept separate rather than reused
--      because the two walks persist different queue-item shapes and
--      conflating them would make findResumableDocument()-style lookups
--      ambiguous across doc_types. documents.resume_claim_expires_at (added
--      for Municode's concurrency-race fix) is generic and reused as-is.

ALTER TABLE documents DROP CONSTRAINT documents_doc_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_doc_type_check CHECK (doc_type IN (
  'budget_pdf', 'bos_minutes', 'bos_summary', 'ordinance', 'municode_api', 'encode_zoning'
));

ALTER TABLE pending_ingestions DROP CONSTRAINT pending_ingestions_doc_type_check;
ALTER TABLE pending_ingestions ADD CONSTRAINT pending_ingestions_doc_type_check CHECK (doc_type IN (
  'budget_pdf', 'bos_minutes', 'bos_summary', 'ordinance', 'municode_api', 'encode_zoning'
));

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS encode_resume_state jsonb;

ALTER TABLE ordinance_provisions
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'municode'
    CHECK (source_type IN ('municode', 'encode_zoning'));

CREATE INDEX IF NOT EXISTS ordinance_provisions_source_type_idx
  ON ordinance_provisions (source_type);
