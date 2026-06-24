-- Migration 007: policy_decisions table
-- Fiscal and policy decisions extracted from Board meeting documents.
-- UUID v7: always Deno-generated. No server-side default on id.

CREATE TABLE policy_decisions (
  id                    uuid PRIMARY KEY,
  document_id           uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  vote_tally_id         uuid NULL REFERENCES vote_tallies(id) ON DELETE SET NULL,
  meeting_date          date NOT NULL,
  decision_type         text NOT NULL CHECK (decision_type IN (
                          'tax_rate', 'fee_schedule', 'appropriation',
                          'budget_adoption', 'bond_authorization',
                          'grant_acceptance', 'other'
                        )),
  subject               text NOT NULL,
  fiscal_year           int NULL,
  amount_dollars        numeric(15,2) NULL,
  rate_value            numeric(10,4) NULL,
  rate_unit             text NULL,
  effective_date        date NULL,
  is_amendment          boolean NOT NULL DEFAULT false,
  amends_decision_id    uuid NULL REFERENCES policy_decisions(id) ON DELETE RESTRICT,
  raw_extracted_text    text NOT NULL,
  page_number_start     int NULL,
  page_number_end       int NULL,
  bbox_start            jsonb NULL,
  bbox_end              jsonb NULL,
  chunk_sequence        int NOT NULL,
  embedding             vector(384),
  content_tsv           tsvector,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON policy_decisions (document_id);
CREATE INDEX ON policy_decisions (vote_tally_id);
CREATE INDEX ON policy_decisions (meeting_date);
CREATE INDEX ON policy_decisions (decision_type);
CREATE INDEX ON policy_decisions (fiscal_year);
CREATE INDEX ON policy_decisions (amends_decision_id)
  WHERE amends_decision_id IS NOT NULL;
CREATE INDEX ON policy_decisions USING gin (content_tsv);
CREATE INDEX ON policy_decisions
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

ALTER TABLE policy_decisions ENABLE ROW LEVEL SECURITY;
