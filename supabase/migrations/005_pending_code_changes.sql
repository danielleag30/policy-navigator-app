-- Migration 005: pending_code_changes table
-- Tracks proposed or in-flight code changes not yet codified in Municode.
-- UUID v7: always Deno-generated. No server-side default on id.

CREATE TABLE pending_code_changes (
  id                    uuid PRIMARY KEY,
  municode_node_id      text NOT NULL,
  proposed_text         text NULL,
  on_spot_edits         text NULL,
  codification_status   text NOT NULL DEFAULT 'pending' CHECK (
                          codification_status IN (
                            'pending', 'codified', 'superseded'
                          )),
  effective_date        date NOT NULL,
  effective_date_source text NOT NULL CHECK (effective_date_source IN (
                          'default', 'municode_note', 'bos_summary'
                        )),
  amendment_event_id    uuid NOT NULL REFERENCES amendment_events(id) ON DELETE RESTRICT,
  document_id           uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  codified_at           timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON pending_code_changes (municode_node_id);
CREATE INDEX ON pending_code_changes (codification_status);
CREATE INDEX ON pending_code_changes (effective_date);
CREATE INDEX ON pending_code_changes (amendment_event_id);
CREATE INDEX ON pending_code_changes (document_id);
CREATE INDEX ON pending_code_changes (municode_node_id, codification_status);

ALTER TABLE pending_code_changes ENABLE ROW LEVEL SECURITY;
