-- Migration: amendment_resolution_logs table
-- Audit trail for the amendment-resolution consumer step (closes the gap between
-- policy_decisions.is_amendment and pending_code_changes/amendment_events -- see
-- spec Section 2: the Board can adopt amendments before Municode codifies them).
--
-- One row per policy_decisions.id ever attempted, so repeat invocations don't
-- reprocess the same decision or duplicate downstream writes. Both the
-- "resolved" and "unresolved" (correctly skipped, no confident match) outcomes
-- are logged here -- unresolved rows are never guessed, only recorded.
-- UUID v7: always Deno-generated. No server-side default on id.

CREATE TABLE amendment_resolution_logs (
  id                     uuid PRIMARY KEY,
  policy_decision_id     uuid NOT NULL REFERENCES policy_decisions(id) ON DELETE RESTRICT,
  status                 text NOT NULL CHECK (status IN ('resolved', 'unresolved')),
  reason                 text NULL CHECK (reason IN (
                           'missing_vote_tally', 'no_candidates', 'low_confidence',
                           'llm_exhausted'
                         )),
  municode_node_id       text NULL,
  confidence             text NULL CHECK (confidence IN ('high', 'medium', 'low')),
  llm_notes              text NULL,
  amendment_event_id     uuid NULL REFERENCES amendment_events(id) ON DELETE SET NULL,
  pending_code_change_id uuid NULL REFERENCES pending_code_changes(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amendment_resolution_logs_policy_decision_id_key
    UNIQUE (policy_decision_id)
);

CREATE INDEX ON amendment_resolution_logs (policy_decision_id);
CREATE INDEX ON amendment_resolution_logs (status);
CREATE INDEX ON amendment_resolution_logs (municode_node_id);
CREATE INDEX ON amendment_resolution_logs (amendment_event_id);
CREATE INDEX ON amendment_resolution_logs (pending_code_change_id);

ALTER TABLE amendment_resolution_logs ENABLE ROW LEVEL SECURITY;
