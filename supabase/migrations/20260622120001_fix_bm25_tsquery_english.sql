-- Fix BM25 tsquery config mismatch.
-- Migration 012 created triggers for ordinance_provisions and budget_indicators using
-- 'simple' tsvector config. The query-pipeline BM25 functions (20260621000001) use
-- plainto_tsquery('english', ...) — configs must match for @@ to return results.
-- Standardize both tables to 'english', reusing set_content_tsv() from migration 011.

DROP TRIGGER IF EXISTS ordinance_provisions_tsv ON ordinance_provisions;
DROP TRIGGER IF EXISTS budget_indicators_tsv     ON budget_indicators;
DROP FUNCTION IF EXISTS set_content_tsv_simple();

CREATE TRIGGER ordinance_provisions_tsv
  BEFORE INSERT OR UPDATE ON ordinance_provisions
  FOR EACH ROW EXECUTE FUNCTION set_content_tsv('content');

CREATE TRIGGER budget_indicators_tsv
  BEFORE INSERT OR UPDATE ON budget_indicators
  FOR EACH ROW EXECUTE FUNCTION set_content_tsv('raw_extracted_text');

-- Backfill existing rows to english config
UPDATE ordinance_provisions
  SET content_tsv = to_tsvector('english', content)
  WHERE content IS NOT NULL;

UPDATE budget_indicators
  SET content_tsv = to_tsvector('english', raw_extracted_text)
  WHERE raw_extracted_text IS NOT NULL;
