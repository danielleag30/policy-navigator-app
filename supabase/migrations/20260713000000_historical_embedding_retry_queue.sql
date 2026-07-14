-- Retry queue metadata for historical Municode ordinance_provisions embeddings.
-- Historical rows are inserted as is_current=false; when the external /embed
-- endpoint is unavailable, these fields let the normal ingest-orchestrator
-- cron poll pick due null-embedding rows back up without a manual admin call.

ALTER TABLE ordinance_provisions
  ADD COLUMN IF NOT EXISTS historical_embedding_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS historical_embedding_next_attempt_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS historical_embedding_last_error text NULL;

CREATE INDEX IF NOT EXISTS ordinance_provisions_historical_embedding_retry_idx
  ON ordinance_provisions (historical_embedding_next_attempt_at)
  WHERE is_current = false
    AND embedding IS NULL;

-- The unique one-current-row constraint is already a usable btree index, but
-- keep this explicit partial lookup index for query plans and review clarity.
CREATE INDEX IF NOT EXISTS ordinance_provisions_current_municode_node_id_idx
  ON ordinance_provisions (municode_node_id)
  WHERE is_current = true;
