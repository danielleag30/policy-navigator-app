-- Migration 001: documents table
-- Source table for all ingested documents (PDFs, BOS minutes, Municode API responses).
-- No hard deletes — status flags only.
-- UUID v7 is approximated via gen_random_uuid() (pg_crypto); Deno-side UUIDs will be true v7.

CREATE TABLE documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url                 text NOT NULL UNIQUE,
  filename            text NULL,
  doc_type            text NOT NULL CHECK (doc_type IN (
                        'budget_pdf', 'bos_minutes',
                        'bos_summary', 'ordinance', 'municode_api'
                      )),
  status              text NOT NULL DEFAULT 'current' CHECK (status IN (
                        'current', 'superseded', 'unknown'
                      )),
  ingested_at         timestamptz NOT NULL,
  last_checked_at     timestamptz NOT NULL,
  content_hash        text NOT NULL,
  source_published_at date NULL,
  title               text NULL,
  fiscal_year         int NULL,
  docling_version     text NULL,
  raw_api_response    jsonb NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON documents (doc_type);
CREATE INDEX ON documents (status);
CREATE INDEX ON documents (last_checked_at);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
