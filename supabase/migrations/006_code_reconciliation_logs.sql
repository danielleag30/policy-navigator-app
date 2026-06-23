-- Migration 006: code_reconciliation_logs table
-- Audit trail for code reconciliation between pending_code_changes and ordinance_provisions.
-- UUID v7: always Deno-generated. No server-side default on id.
-- UNIQUE (pending_code_change_id, ordinance_provision_id) prevents duplicate reconciliation
-- records from concurrent triggers.

CREATE TABLE code_reconciliation_logs (
  id                      uuid PRIMARY KEY,
  municode_node_id        text NOT NULL,
  pending_code_change_id  uuid NOT NULL REFERENCES pending_code_changes(id) ON DELETE RESTRICT,
  ordinance_provision_id  uuid NOT NULL REFERENCES ordinance_provisions(id) ON DELETE RESTRICT,
  document_id             uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  reconciliation_result   text NOT NULL CHECK (reconciliation_result IN (
                            'matched', 'partial_match', 'mismatch', 'not_found'
                          )),
  llm_comparison_notes    text NULL,
  requires_human_review   boolean NOT NULL DEFAULT false,
  human_reviewed_at       timestamptz NULL,
  human_reviewer_notes    text NULL,
  supplement_job_id       text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_reconciliation_logs_unique_pair
    UNIQUE (pending_code_change_id, ordinance_provision_id)
);

CREATE INDEX ON code_reconciliation_logs (municode_node_id);
CREATE INDEX ON code_reconciliation_logs (pending_code_change_id);
CREATE INDEX ON code_reconciliation_logs (ordinance_provision_id);
CREATE INDEX ON code_reconciliation_logs (document_id);
CREATE INDEX ON code_reconciliation_logs (reconciliation_result);
CREATE INDEX ON code_reconciliation_logs (requires_human_review)
  WHERE requires_human_review = true;

ALTER TABLE code_reconciliation_logs ENABLE ROW LEVEL SECURITY;
