-- Migration 002: ordinance_provisions table
-- Versioned ordinance provision rows extracted from Municode sources.
-- UUID v7: always Deno-generated (application side). No server-side default.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE ordinance_provisions (
  id                uuid PRIMARY KEY,
  document_id       uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  municode_node_id  text NOT NULL,
  effective_date    date NOT NULL,
  is_current        boolean NOT NULL DEFAULT false,
  section_title     text,
  content           text NOT NULL,
  content_tsv       tsvector,
  embedding         vector(384),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ordinance_provisions_municode_node_id_effective_date_key
    UNIQUE (municode_node_id, effective_date)
);

CREATE INDEX ordinance_provisions_document_id_idx
  ON ordinance_provisions (document_id);

CREATE INDEX ordinance_provisions_municode_node_id_idx
  ON ordinance_provisions (municode_node_id);

CREATE INDEX ordinance_provisions_is_current_idx
  ON ordinance_provisions (is_current);

CREATE INDEX ordinance_provisions_effective_date_idx
  ON ordinance_provisions (effective_date);

CREATE UNIQUE INDEX ordinance_provisions_one_current_per_node_idx
  ON ordinance_provisions (municode_node_id)
  WHERE is_current = true;

CREATE INDEX ordinance_provisions_content_tsv_idx
  ON ordinance_provisions
  USING gin (content_tsv);

CREATE INDEX ordinance_provisions_embedding_hnsw_idx
  ON ordinance_provisions
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

ALTER TABLE ordinance_provisions ENABLE ROW LEVEL SECURITY;
