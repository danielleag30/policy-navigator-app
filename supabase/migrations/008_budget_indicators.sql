-- Migration 008: budget_indicators table
-- Performance and budget indicators extracted from Budget Committee materials.
-- UUID v7: always Deno-generated. No server-side default on id.
-- NOTE: indicator_type column intentionally absent (v1.1 deferral).
-- LLM classification unreliable without structured signal; will be added
-- via migration + backfill when query logs demonstrate need.

CREATE TABLE budget_indicators (
  id                  uuid PRIMARY KEY,
  document_id         uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  fiscal_year         int NOT NULL,
  department          text NULL,
  program             text NULL,
  indicator_name      text NOT NULL,
  value_actual        numeric(15,4) NULL,
  value_target        numeric(15,4) NULL,
  value_prior_year    numeric(15,4) NULL,
  unit                text NULL,
  raw_extracted_text  text NOT NULL,
  page_number_start   int NULL,
  page_number_end     int NULL,
  bbox_start          jsonb NULL,
  bbox_end            jsonb NULL,
  chunk_sequence      int NOT NULL,
  embedding           vector(384),
  content_tsv         tsvector,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON budget_indicators (document_id);
CREATE INDEX ON budget_indicators (fiscal_year);
CREATE INDEX ON budget_indicators (department);
CREATE INDEX ON budget_indicators USING gin (content_tsv);
CREATE INDEX ON budget_indicators
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

ALTER TABLE budget_indicators ENABLE ROW LEVEL SECURITY;
