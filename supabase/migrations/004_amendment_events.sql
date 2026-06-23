-- Migration 004: amendment_events table
-- Records when the Board of Supervisors officially adopted an amendment.
-- Intentionally NO FK to ordinance_provisions: the Board can adopt amendments
-- before Municode codifies them. Join is performed at query time on
-- municode_node_id (text). See spec Section 2, Layer 1 notes.

CREATE TABLE amendment_events (
  id                    uuid PRIMARY KEY,
  municode_node_id      text NOT NULL,
  ordinance_number      text NULL,
  resolution_number     text NULL,
  adopted_date          date NOT NULL,
  effective_date        date NOT NULL,
  effective_date_source text NOT NULL CHECK (effective_date_source IN (
                          'default', 'municode_note', 'bos_summary'
                        )),
  amendment_text        text NULL,
  vote_tally_id         uuid NOT NULL REFERENCES vote_tallies(id) ON DELETE RESTRICT,
  document_id           uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON amendment_events (municode_node_id);
CREATE INDEX ON amendment_events (adopted_date);
CREATE INDEX ON amendment_events (effective_date);
CREATE INDEX ON amendment_events (vote_tally_id);
CREATE INDEX ON amendment_events (document_id);

ALTER TABLE amendment_events ENABLE ROW LEVEL SECURITY;
