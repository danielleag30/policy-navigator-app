-- Migration 011: tsvector triggers
-- Populate content_tsv on INSERT/UPDATE using english language config.
-- Tables: narrative_chunks (content), policy_decisions (raw_extracted_text),
--         vote_tallies (motion_text).

-- One generic function + per-table triggers via TG_ARGV
CREATE OR REPLACE FUNCTION set_content_tsv()
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
    ELSE to_tsvector('english', src_val)
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER narrative_chunks_tsv
  BEFORE INSERT OR UPDATE ON narrative_chunks
  FOR EACH ROW EXECUTE FUNCTION set_content_tsv('content');

CREATE TRIGGER policy_decisions_tsv
  BEFORE INSERT OR UPDATE ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION set_content_tsv('raw_extracted_text');

CREATE TRIGGER vote_tallies_tsv
  BEFORE INSERT OR UPDATE ON vote_tallies
  FOR EACH ROW EXECUTE FUNCTION set_content_tsv('motion_text');
