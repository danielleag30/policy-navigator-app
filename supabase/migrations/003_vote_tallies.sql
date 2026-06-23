-- Migration 003: vote_tallies table
-- Board of Supervisors vote records extracted from meeting minutes.
-- UUID v7: always Deno-generated. No server-side default on id.

CREATE TABLE vote_tallies (
  id                uuid PRIMARY KEY,
  document_id       uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  meeting_date      date NOT NULL,
  motion_text       text NOT NULL,
  motion_type       text NOT NULL CHECK (motion_type IN (
                      'ordinance', 'resolution', 'proclamation',
                      'approval', 'adoption', 'authorization',
                      'appointment', 'motion', 'other'
                    )),
  outcome           text NOT NULL CHECK (outcome IN (
                      'passed', 'failed', 'tabled', 'withdrawn', 'deferred'
                    )),
  vote_yes          int NOT NULL DEFAULT 0,
  vote_no           int NOT NULL DEFAULT 0,
  vote_abstain      int NOT NULL DEFAULT 0,
  vote_absent       int NOT NULL DEFAULT 0,
  individual_votes  jsonb NULL,
  reconsidered_by   uuid NULL REFERENCES vote_tallies(id) ON DELETE RESTRICT,
  page_number_start int NULL,
  page_number_end   int NULL,
  bbox_start        jsonb NULL,
  bbox_end          jsonb NULL,
  chunk_sequence    int NOT NULL,
  embedding         vector(384),
  content_tsv       tsvector,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Regular indexes
CREATE INDEX ON vote_tallies (document_id);
CREATE INDEX ON vote_tallies (meeting_date);
CREATE INDEX ON vote_tallies (outcome);
CREATE INDEX ON vote_tallies (motion_type);

-- Partial index: only rows where reconsidered_by is set
CREATE INDEX ON vote_tallies (reconsidered_by)
  WHERE reconsidered_by IS NOT NULL;

-- GIN indexes
CREATE INDEX ON vote_tallies USING gin (individual_votes);
CREATE INDEX ON vote_tallies USING gin (content_tsv);

-- HNSW vector index
CREATE INDEX ON vote_tallies
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

ALTER TABLE vote_tallies ENABLE ROW LEVEL SECURITY;
