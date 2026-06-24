-- Migration 009: narrative_chunks table
-- Free-form text chunks from narrative Budget Committee documents.
-- UUID v7: always Deno-generated. No server-side default on id.

CREATE TABLE narrative_chunks (
  id                  uuid PRIMARY KEY,
  document_id         uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  chunk_sequence      int NOT NULL,
  content             text NOT NULL,
  token_count         int NOT NULL,
  overlap_prev        boolean NOT NULL DEFAULT false,
  overlap_next        boolean NOT NULL DEFAULT false,
  section_heading     text NULL,
  page_number_start   int NULL,
  page_number_end     int NULL,
  bbox_start          jsonb NULL,
  bbox_end            jsonb NULL,
  content_tsv         tsvector,
  embedding           vector(384),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT narrative_chunks_document_id_chunk_sequence_key
    UNIQUE (document_id, chunk_sequence)
);

CREATE INDEX ON narrative_chunks (document_id);
CREATE INDEX ON narrative_chunks (chunk_sequence);
CREATE INDEX ON narrative_chunks USING gin (content_tsv);
CREATE INDEX ON narrative_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

ALTER TABLE narrative_chunks ENABLE ROW LEVEL SECURITY;
