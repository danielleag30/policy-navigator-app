-- Atomic lease/claim guard for resuming a paused Municode ingestion walk.
--
-- Without this, two concurrent ingest-orchestrator invocations (e.g.
-- overlapping pending_ingestions triggers from the timeout watchdog) could
-- both find the same documents.municode_resume_state row via
-- findResumableDocument() and both drain the same queue simultaneously,
-- producing duplicate/lost ordinance_provisions rows.
--
-- findResumableDocument() (municode.ts) now claims exclusive ownership of a
-- resumable document via a single conditional
-- UPDATE ... WHERE resume_claim_expires_at IS NULL OR resume_claim_expires_at < now() ... RETURNING
-- before draining its queue. The lease is released (set back to null) as
-- soon as the invocation stops working on the document — either by
-- persisting a fresh pause point or by completing the walk — so a losing
-- invocation only ever waits out the lease window in the worst case.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS resume_claim_expires_at timestamptz;
