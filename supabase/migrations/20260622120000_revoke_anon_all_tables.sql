-- Revoke all public-schema table privileges from anon and authenticated.
-- documents was covered in 001_documents.sql and 20260618001117_002_documents_revoke_client_grants.sql.
-- reconciliation_events and sources are not yet created; they will be covered on creation.
-- private.app_config lives in a separate schema; REVOKE is a no-op if no grant exists.

REVOKE ALL ON TABLE ordinance_provisions    FROM anon, authenticated;
REVOKE ALL ON TABLE vote_tallies            FROM anon, authenticated;
REVOKE ALL ON TABLE amendment_events        FROM anon, authenticated;
REVOKE ALL ON TABLE pending_code_changes    FROM anon, authenticated;
REVOKE ALL ON TABLE code_reconciliation_logs FROM anon, authenticated;
REVOKE ALL ON TABLE policy_decisions        FROM anon, authenticated;
REVOKE ALL ON TABLE budget_indicators       FROM anon, authenticated;
REVOKE ALL ON TABLE narrative_chunks        FROM anon, authenticated;
REVOKE ALL ON TABLE pending_ingestions      FROM anon, authenticated;
REVOKE ALL ON TABLE rate_limit_buckets      FROM anon, authenticated;
REVOKE ALL ON TABLE request_logs            FROM anon, authenticated;
REVOKE ALL ON TABLE pending_alerts          FROM anon, authenticated;
REVOKE ALL ON TABLE document_chunks         FROM anon, authenticated;
REVOKE ALL ON TABLE private.app_config      FROM anon, authenticated;
