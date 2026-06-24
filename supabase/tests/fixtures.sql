-- supabase/tests/fixtures.sql
-- Phase 1 schema test fixtures.
-- Run with: psql $DATABASE_URL -f supabase/tests/fixtures.sql
-- All test data is cleaned up at the end via ROLLBACK.

BEGIN;

-- ============================================================
-- ID registry — one place to generate and reference all UUIDs
-- ============================================================
CREATE TEMP TABLE _fix_ids (key text PRIMARY KEY, id uuid);

INSERT INTO _fix_ids (key, id) VALUES
  ('doc_1',   gen_random_uuid()),
  ('op_1',    gen_random_uuid()),
  ('vt_1',    gen_random_uuid()),
  ('ae_1',    gen_random_uuid()),
  ('pcc_1',   gen_random_uuid()),
  ('pcc_2',   gen_random_uuid()),
  ('crl_1',   gen_random_uuid()),
  ('pd_1',    gen_random_uuid()),
  ('bi_1',    gen_random_uuid()),
  ('nc_1',    gen_random_uuid()),
  ('pi_1',    gen_random_uuid()),
  ('rlb_1',   gen_random_uuid()),
  ('rl_1',    gen_random_uuid()),
  ('pa_1',    gen_random_uuid());

-- Helper: fetch an id by key
CREATE OR REPLACE FUNCTION _fix_id(k text) RETURNS uuid LANGUAGE sql AS
  $$ SELECT id FROM _fix_ids WHERE key = k; $$;

-- ============================================================
-- Section 1: Valid inserts (ordered by FK dependency)
-- ============================================================

-- 1. documents (no FKs — root table)
INSERT INTO documents (
  id, url, filename, doc_type, status,
  ingested_at, last_checked_at, content_hash,
  source_published_at, title, fiscal_year
) VALUES (
  _fix_id('doc_1'),
  'https://example.gov/bos-minutes-2025-01-07.pdf',
  'bos-minutes-2025-01-07.pdf',
  'bos_minutes',
  'current',
  now(), now(),
  'abc123deadbeef',
  '2025-01-07',
  'Board of Supervisors Minutes 2025-01-07',
  2025
);

-- 2. ordinance_provisions (FK → documents)
INSERT INTO ordinance_provisions (
  id, document_id, municode_node_id, effective_date,
  is_current, section_title, content
) VALUES (
  _fix_id('op_1'),
  _fix_id('doc_1'),
  'TITLE_2_CH_2_ART_1_SEC_2-1',
  '2025-01-07',
  true,
  'Section 2-1: General Provisions',
  'The Board of Supervisors shall meet at least once per month.'
);

-- 3. vote_tallies (FK → documents)
INSERT INTO vote_tallies (
  id, document_id, meeting_date, motion_text, motion_type,
  outcome, vote_yes, vote_no, chunk_sequence
) VALUES (
  _fix_id('vt_1'),
  _fix_id('doc_1'),
  '2025-01-07',
  'Motion to adopt Ordinance No. 2025-001 amending Title 2.',
  'ordinance',
  'passed',
  5, 0,
  1
);

-- 4. amendment_events (FK → vote_tallies, documents)
INSERT INTO amendment_events (
  id, municode_node_id, ordinance_number, adopted_date,
  effective_date, effective_date_source, amendment_text,
  vote_tally_id, document_id
) VALUES (
  _fix_id('ae_1'),
  'TITLE_2_CH_2_ART_1_SEC_2-1',
  'ORD-2025-001',
  '2025-01-07',
  '2025-02-01',
  'bos_summary',
  'Amend Section 2-1 to require bi-weekly meetings.',
  _fix_id('vt_1'),
  _fix_id('doc_1')
);

-- 5. pending_code_changes (FK → amendment_events, documents)
INSERT INTO pending_code_changes (
  id, municode_node_id, proposed_text, codification_status,
  effective_date, effective_date_source,
  amendment_event_id, document_id
) VALUES (
  _fix_id('pcc_1'),
  'TITLE_2_CH_2_ART_1_SEC_2-1',
  'The Board of Supervisors shall meet at least bi-weekly.',
  'pending',
  '2025-02-01',
  'bos_summary',
  _fix_id('ae_1'),
  _fix_id('doc_1')
);

-- 5b. pcc_2 — second pending_code_change used only in FK rejection tests (avoids UNIQUE collision on crl)
INSERT INTO pending_code_changes (
  id, municode_node_id, proposed_text, codification_status,
  effective_date, effective_date_source,
  amendment_event_id, document_id
) VALUES (
  _fix_id('pcc_2'),
  'TITLE_2_CH_2_ART_1_SEC_2-2',
  'The Board of Supervisors shall hold public hearings monthly.',
  'pending',
  '2025-03-01',
  'bos_summary',
  _fix_id('ae_1'),
  _fix_id('doc_1')
);

-- 6. code_reconciliation_logs (FK → pending_code_changes, ordinance_provisions, documents)
INSERT INTO code_reconciliation_logs (
  id, municode_node_id, pending_code_change_id,
  ordinance_provision_id, document_id,
  reconciliation_result, supplement_job_id
) VALUES (
  _fix_id('crl_1'),
  'TITLE_2_CH_2_ART_1_SEC_2-1',
  _fix_id('pcc_1'),
  _fix_id('op_1'),
  _fix_id('doc_1'),
  'matched',
  'job-fixture-001'
);

-- 7. policy_decisions (FK → documents; vote_tally_id nullable)
INSERT INTO policy_decisions (
  id, document_id, meeting_date, decision_type,
  subject, raw_extracted_text, chunk_sequence
) VALUES (
  _fix_id('pd_1'),
  _fix_id('doc_1'),
  '2025-01-07',
  'appropriation',
  'General Fund appropriation for FY 2025',
  'The Board approved a General Fund appropriation of $1,000,000 for FY 2025.',
  1
);

-- 8. budget_indicators (FK → documents; no CHECK constraints)
INSERT INTO budget_indicators (
  id, document_id, fiscal_year, indicator_name,
  raw_extracted_text, chunk_sequence
) VALUES (
  _fix_id('bi_1'),
  _fix_id('doc_1'),
  2025,
  'General Fund Reserve Ratio',
  'General Fund Reserve Ratio: 15% (target: 12%)',
  1
);

-- 9. narrative_chunks (FK → documents; UNIQUE(document_id, chunk_sequence))
INSERT INTO narrative_chunks (
  id, document_id, chunk_sequence, content, token_count
) VALUES (
  _fix_id('nc_1'),
  _fix_id('doc_1'),
  1,
  'The County Administrator presented the proposed FY 2025 budget.',
  12
);

-- 10. pending_ingestions (no FK)
INSERT INTO pending_ingestions (
  id, url, doc_type, status
) VALUES (
  _fix_id('pi_1'),
  'https://example.gov/ordinance-2025-001.pdf',
  'ordinance',
  'pending'
);

-- 11. rate_limit_buckets (no FK; UNIQUE(ip_address, window_start))
INSERT INTO rate_limit_buckets (
  id, ip_address, window_start, request_count
) VALUES (
  _fix_id('rlb_1'),
  '192.0.2.1',
  now(),
  3
);

-- 12. request_logs (no FK, no CHECK)
INSERT INTO request_logs (
  id, ip_address, query_text, response_ms,
  chunk_count, llm_calls
) VALUES (
  _fix_id('rl_1'),
  '192.0.2.1',
  'What is the current property tax rate?',
  450,
  5,
  1
);

-- 13. pending_alerts (no FK)
INSERT INTO pending_alerts (
  id, alert_type, details
) VALUES (
  _fix_id('pa_1'),
  'rate_abuse',
  '{"ip": "192.0.2.99", "count": 200}'::jsonb
);

-- ============================================================
-- Section 2: CHECK constraint rejection tests
-- ============================================================

-- documents.doc_type CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO documents (id, url, doc_type, status, ingested_at, last_checked_at, content_hash)
    VALUES (gen_random_uuid(), 'https://x.test/bad-doc-type', 'INVALID_DOC_TYPE', 'current', now(), now(), 'h1');
    RAISE EXCEPTION 'Expected check_violation on documents.doc_type but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- documents.status CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO documents (id, url, doc_type, status, ingested_at, last_checked_at, content_hash)
    VALUES (gen_random_uuid(), 'https://x.test/bad-status', 'bos_minutes', 'INVALID_STATUS', now(), now(), 'h2');
    RAISE EXCEPTION 'Expected check_violation on documents.status but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- vote_tallies.motion_type CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO vote_tallies (id, document_id, meeting_date, motion_text, motion_type, outcome, chunk_sequence)
    VALUES (gen_random_uuid(), _fix_id('doc_1'), '2025-01-07', 'Bad motion', 'INVALID_MOTION', 'passed', 99);
    RAISE EXCEPTION 'Expected check_violation on vote_tallies.motion_type but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- vote_tallies.outcome CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO vote_tallies (id, document_id, meeting_date, motion_text, motion_type, outcome, chunk_sequence)
    VALUES (gen_random_uuid(), _fix_id('doc_1'), '2025-01-07', 'Bad outcome', 'ordinance', 'INVALID_OUTCOME', 99);
    RAISE EXCEPTION 'Expected check_violation on vote_tallies.outcome but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- amendment_events.effective_date_source CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO amendment_events (id, municode_node_id, adopted_date, effective_date, effective_date_source, vote_tally_id, document_id)
    VALUES (gen_random_uuid(), 'NODE_1', '2025-01-07', '2025-02-01', 'INVALID_SOURCE', _fix_id('vt_1'), _fix_id('doc_1'));
    RAISE EXCEPTION 'Expected check_violation on amendment_events.effective_date_source but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- pending_code_changes.codification_status CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO pending_code_changes (id, municode_node_id, codification_status, effective_date, effective_date_source, amendment_event_id, document_id)
    VALUES (gen_random_uuid(), 'NODE_1', 'INVALID_STATUS', '2025-02-01', 'default', _fix_id('ae_1'), _fix_id('doc_1'));
    RAISE EXCEPTION 'Expected check_violation on pending_code_changes.codification_status but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- pending_code_changes.effective_date_source CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO pending_code_changes (id, municode_node_id, codification_status, effective_date, effective_date_source, amendment_event_id, document_id)
    VALUES (gen_random_uuid(), 'NODE_1', 'pending', '2025-02-01', 'INVALID_SOURCE', _fix_id('ae_1'), _fix_id('doc_1'));
    RAISE EXCEPTION 'Expected check_violation on pending_code_changes.effective_date_source but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- code_reconciliation_logs.reconciliation_result CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO code_reconciliation_logs (id, municode_node_id, pending_code_change_id, ordinance_provision_id, document_id, reconciliation_result, supplement_job_id)
    VALUES (gen_random_uuid(), 'NODE_1', _fix_id('pcc_1'), _fix_id('op_1'), _fix_id('doc_1'), 'INVALID_RESULT', 'job-bad-1');
    RAISE EXCEPTION 'Expected check_violation on code_reconciliation_logs.reconciliation_result but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- policy_decisions.decision_type CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO policy_decisions (id, document_id, meeting_date, decision_type, subject, raw_extracted_text, chunk_sequence)
    VALUES (gen_random_uuid(), _fix_id('doc_1'), '2025-01-07', 'INVALID_TYPE', 'bad subject', 'raw text', 99);
    RAISE EXCEPTION 'Expected check_violation on policy_decisions.decision_type but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- pending_ingestions.doc_type CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO pending_ingestions (id, url, doc_type, status)
    VALUES (gen_random_uuid(), 'https://x.test/bad', 'INVALID_DOC_TYPE', 'pending');
    RAISE EXCEPTION 'Expected check_violation on pending_ingestions.doc_type but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- pending_ingestions.status CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO pending_ingestions (id, url, doc_type, status)
    VALUES (gen_random_uuid(), 'https://x.test/bad2', 'ordinance', 'INVALID_STATUS');
    RAISE EXCEPTION 'Expected check_violation on pending_ingestions.status but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- pending_alerts.alert_type CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO pending_alerts (id, alert_type, details)
    VALUES (gen_random_uuid(), 'INVALID_ALERT', '{}'::jsonb);
    RAISE EXCEPTION 'Expected check_violation on pending_alerts.alert_type but none raised';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END; $$;

-- ============================================================
-- Section 3: FK rejection tests
-- ============================================================

-- ordinance_provisions.document_id → documents(id)
DO $$
BEGIN
  BEGIN
    INSERT INTO ordinance_provisions (id, document_id, municode_node_id, effective_date, content)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'NODE_FK_1', '2025-01-01', 'some content');
    RAISE EXCEPTION 'Expected foreign_key_violation on ordinance_provisions.document_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- vote_tallies.document_id → documents(id)
DO $$
BEGIN
  BEGIN
    INSERT INTO vote_tallies (id, document_id, meeting_date, motion_text, motion_type, outcome, chunk_sequence)
    VALUES (gen_random_uuid(), gen_random_uuid(), '2025-01-07', 'Bad FK motion', 'ordinance', 'passed', 99);
    RAISE EXCEPTION 'Expected foreign_key_violation on vote_tallies.document_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- amendment_events.vote_tally_id → vote_tallies(id)
DO $$
BEGIN
  BEGIN
    INSERT INTO amendment_events (id, municode_node_id, adopted_date, effective_date, effective_date_source, vote_tally_id, document_id)
    VALUES (gen_random_uuid(), 'NODE_FK_2', '2025-01-07', '2025-02-01', 'default', gen_random_uuid(), _fix_id('doc_1'));
    RAISE EXCEPTION 'Expected foreign_key_violation on amendment_events.vote_tally_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- amendment_events.document_id → documents(id)
DO $$
BEGIN
  BEGIN
    INSERT INTO amendment_events (id, municode_node_id, adopted_date, effective_date, effective_date_source, vote_tally_id, document_id)
    VALUES (gen_random_uuid(), 'NODE_FK_3', '2025-01-07', '2025-02-01', 'default', _fix_id('vt_1'), gen_random_uuid());
    RAISE EXCEPTION 'Expected foreign_key_violation on amendment_events.document_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- pending_code_changes.amendment_event_id → amendment_events(id)
DO $$
BEGIN
  BEGIN
    INSERT INTO pending_code_changes (id, municode_node_id, codification_status, effective_date, effective_date_source, amendment_event_id, document_id)
    VALUES (gen_random_uuid(), 'NODE_FK_4', 'pending', '2025-02-01', 'default', gen_random_uuid(), _fix_id('doc_1'));
    RAISE EXCEPTION 'Expected foreign_key_violation on pending_code_changes.amendment_event_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- pending_code_changes.document_id → documents(id)
DO $$
BEGIN
  BEGIN
    INSERT INTO pending_code_changes (id, municode_node_id, codification_status, effective_date, effective_date_source, amendment_event_id, document_id)
    VALUES (gen_random_uuid(), 'NODE_FK_5', 'pending', '2025-02-01', 'default', _fix_id('ae_1'), gen_random_uuid());
    RAISE EXCEPTION 'Expected foreign_key_violation on pending_code_changes.document_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- code_reconciliation_logs.pending_code_change_id → pending_code_changes(id)
DO $$
BEGIN
  BEGIN
    INSERT INTO code_reconciliation_logs (id, municode_node_id, pending_code_change_id, ordinance_provision_id, document_id, reconciliation_result, supplement_job_id)
    VALUES (gen_random_uuid(), 'NODE_FK_6', gen_random_uuid(), _fix_id('op_1'), _fix_id('doc_1'), 'matched', 'job-fk-1');
    RAISE EXCEPTION 'Expected foreign_key_violation on code_reconciliation_logs.pending_code_change_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- code_reconciliation_logs.ordinance_provision_id → ordinance_provisions(id)
DO $$
BEGIN
  BEGIN
    INSERT INTO code_reconciliation_logs (id, municode_node_id, pending_code_change_id, ordinance_provision_id, document_id, reconciliation_result, supplement_job_id)
    VALUES (gen_random_uuid(), 'NODE_FK_7', _fix_id('pcc_1'), gen_random_uuid(), _fix_id('doc_1'), 'matched', 'job-fk-2');
    RAISE EXCEPTION 'Expected foreign_key_violation on code_reconciliation_logs.ordinance_provision_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- code_reconciliation_logs.document_id → documents(id)
-- Uses pcc_2+op_1 (a pair not yet in the table) to avoid hitting the UNIQUE constraint before the FK check.
DO $$
BEGIN
  BEGIN
    INSERT INTO code_reconciliation_logs (id, municode_node_id, pending_code_change_id, ordinance_provision_id, document_id, reconciliation_result, supplement_job_id)
    VALUES (gen_random_uuid(), 'NODE_FK_8', _fix_id('pcc_2'), _fix_id('op_1'), gen_random_uuid(), 'matched', 'job-fk-3');
    RAISE EXCEPTION 'Expected foreign_key_violation on code_reconciliation_logs.document_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- policy_decisions.document_id → documents(id)
DO $$
BEGIN
  BEGIN
    INSERT INTO policy_decisions (id, document_id, meeting_date, decision_type, subject, raw_extracted_text, chunk_sequence)
    VALUES (gen_random_uuid(), gen_random_uuid(), '2025-01-07', 'appropriation', 'bad fk subject', 'raw text', 99);
    RAISE EXCEPTION 'Expected foreign_key_violation on policy_decisions.document_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- policy_decisions.vote_tally_id → vote_tallies(id)  [nullable FK, must test with non-existent value]
DO $$
BEGIN
  BEGIN
    INSERT INTO policy_decisions (id, document_id, vote_tally_id, meeting_date, decision_type, subject, raw_extracted_text, chunk_sequence)
    VALUES (gen_random_uuid(), _fix_id('doc_1'), gen_random_uuid(), '2025-01-07', 'appropriation', 'bad fk vt', 'raw text', 99);
    RAISE EXCEPTION 'Expected foreign_key_violation on policy_decisions.vote_tally_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- budget_indicators.document_id → documents(id)
DO $$
BEGIN
  BEGIN
    INSERT INTO budget_indicators (id, document_id, fiscal_year, indicator_name, raw_extracted_text, chunk_sequence)
    VALUES (gen_random_uuid(), gen_random_uuid(), 2025, 'Bad FK Indicator', 'raw text', 99);
    RAISE EXCEPTION 'Expected foreign_key_violation on budget_indicators.document_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- narrative_chunks.document_id → documents(id)
DO $$
BEGIN
  BEGIN
    INSERT INTO narrative_chunks (id, document_id, chunk_sequence, content, token_count)
    VALUES (gen_random_uuid(), gen_random_uuid(), 99, 'bad fk chunk', 4);
    RAISE EXCEPTION 'Expected foreign_key_violation on narrative_chunks.document_id but none raised';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END; $$;

-- ============================================================
-- Section 4: UNIQUE constraint rejection tests
-- ============================================================

-- documents.url UNIQUE
DO $$
BEGIN
  BEGIN
    INSERT INTO documents (id, url, doc_type, status, ingested_at, last_checked_at, content_hash)
    VALUES (gen_random_uuid(), 'https://example.gov/bos-minutes-2025-01-07.pdf', 'bos_minutes', 'current', now(), now(), 'dup-hash');
    RAISE EXCEPTION 'Expected unique_violation on documents.url but none raised';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END; $$;

-- ordinance_provisions UNIQUE(municode_node_id, effective_date)
DO $$
BEGIN
  BEGIN
    INSERT INTO ordinance_provisions (id, document_id, municode_node_id, effective_date, content)
    VALUES (gen_random_uuid(), _fix_id('doc_1'), 'TITLE_2_CH_2_ART_1_SEC_2-1', '2025-01-07', 'duplicate node+date');
    RAISE EXCEPTION 'Expected unique_violation on ordinance_provisions(municode_node_id, effective_date) but none raised';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END; $$;

-- ordinance_provisions partial UNIQUE(municode_node_id) WHERE is_current = true
-- (op_1 already has is_current=true for TITLE_2_CH_2_ART_1_SEC_2-1)
DO $$
BEGIN
  BEGIN
    INSERT INTO ordinance_provisions (id, document_id, municode_node_id, effective_date, is_current, content)
    VALUES (gen_random_uuid(), _fix_id('doc_1'), 'TITLE_2_CH_2_ART_1_SEC_2-1', '2024-06-01', true, 'second current for same node');
    RAISE EXCEPTION 'Expected unique_violation on ordinance_provisions partial index (is_current) but none raised';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END; $$;

-- code_reconciliation_logs UNIQUE(pending_code_change_id, ordinance_provision_id)
DO $$
BEGIN
  BEGIN
    INSERT INTO code_reconciliation_logs (id, municode_node_id, pending_code_change_id, ordinance_provision_id, document_id, reconciliation_result, supplement_job_id)
    VALUES (gen_random_uuid(), 'NODE_DUP', _fix_id('pcc_1'), _fix_id('op_1'), _fix_id('doc_1'), 'matched', 'job-dup-1');
    RAISE EXCEPTION 'Expected unique_violation on code_reconciliation_logs(pending_code_change_id, ordinance_provision_id) but none raised';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END; $$;

-- narrative_chunks UNIQUE(document_id, chunk_sequence)
DO $$
BEGIN
  BEGIN
    INSERT INTO narrative_chunks (id, document_id, chunk_sequence, content, token_count)
    VALUES (gen_random_uuid(), _fix_id('doc_1'), 1, 'duplicate chunk sequence', 4);
    RAISE EXCEPTION 'Expected unique_violation on narrative_chunks(document_id, chunk_sequence) but none raised';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END; $$;

-- rate_limit_buckets UNIQUE(ip_address, window_start)
DO $$
DECLARE
  v_window_start timestamptz;
BEGIN
  v_window_start := (SELECT window_start FROM rate_limit_buckets WHERE id = _fix_id('rlb_1'));
  BEGIN
    INSERT INTO rate_limit_buckets (id, ip_address, window_start, request_count)
    VALUES (gen_random_uuid(), '192.0.2.1', v_window_start, 1);
    RAISE EXCEPTION 'Expected unique_violation on rate_limit_buckets(ip_address, window_start) but none raised';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END; $$;

-- ============================================================
-- Cleanup: ROLLBACK removes all inserted test data
-- ============================================================

ROLLBACK;
