-- Migration: document_chunks table + pending_ingestions 'done' status
-- Applied to Supabase 2026-06-20 as part of tasks 2-1/2-3 completion.
-- Reconstructed from live DB schema to keep local migration files in sync.

-- ── document_chunks ───────────────────────────────────────────────────────────
-- Raw text chunks produced by the PDF chunker (task 2-3).
-- Embeddings populated by ingest-orchestrator after gte-small inference (task 2-6).

CREATE TABLE document_chunks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index         int NOT NULL,
  text                text NOT NULL,
  token_count         int NOT NULL,
  page_number_start   int NULL,
  page_number_end     int NULL,
  bbox_start          jsonb NULL,
  bbox_end            jsonb NULL,
  reading_order_start int NOT NULL DEFAULT 0,
  reading_order_end   int NOT NULL DEFAULT 0,
  overlap_prev        boolean NOT NULL DEFAULT false,
  overlap_next        boolean NOT NULL DEFAULT false,
  embedding           vector(384),
  content_tsv         tsvector,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_chunks_document_id_chunk_index_key
    UNIQUE (document_id, chunk_index)
);

CREATE INDEX document_chunks_embedding_idx ON document_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX document_chunks_tsv_idx ON document_chunks
  USING gin (content_tsv);

ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

-- ── pending_ingestions: add 'done' status ─────────────────────────────────────

ALTER TABLE pending_ingestions
  DROP CONSTRAINT pending_ingestions_status_check;
ALTER TABLE pending_ingestions
  ADD CONSTRAINT pending_ingestions_status_check
  CHECK (status IN ('pending', 'processing', 'done', 'failed', 'skipped'));
