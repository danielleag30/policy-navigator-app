-- Persists an in-progress Municode recursive-ingestion cursor so a run that
-- hits the Edge Function soft deadline mid-tree can resume on the next
-- invocation instead of restarting from chapter 1 and orphaning partial rows.
--
-- Non-null only while documents.status = 'unknown' for a doc_type =
-- 'municode_api' row that is mid-recursion; cleared back to null once the
-- walk completes and the caller flips status to 'current'.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS municode_resume_state jsonb;
