-- Migration 012: tsvector triggers — simple language config
-- Populate content_tsv on INSERT/UPDATE using simple language config.
-- Tables: ordinance_provisions (content), budget_indicators (raw_extracted_text).
-- Uses simple config (no stemming) for structured legal/numeric text.
-- NOTE: function named set_content_tsv_simple() to avoid collision with
--       set_content_tsv() (english config) from migration 011.

CREATE OR REPLACE FUNCTION set_content_tsv_simple()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  src_col text := TG_ARGV[0];
  src_val text;
BEGIN
  EXECUTE format('SELECT ($1).%I', src_col) INTO src_val USING NEW;
  NEW.content_tsv := CASE
    WHEN src_val IS NULL THEN NULL
    ELSE to_tsvector('simple', src_val)
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ordinance_provisions_tsv
  BEFORE INSERT OR UPDATE ON ordinance_provisions
  FOR EACH ROW EXECUTE FUNCTION set_content_tsv_simple('content');

CREATE TRIGGER budget_indicators_tsv
  BEFORE INSERT OR UPDATE ON budget_indicators
  FOR EACH ROW EXECUTE FUNCTION set_content_tsv_simple('raw_extracted_text');
