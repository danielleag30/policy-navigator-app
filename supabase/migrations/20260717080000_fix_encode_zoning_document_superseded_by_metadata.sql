-- Corrects the parent documents row's raw_api_response -> superseded_by
-- metadata for the EnCode zoning "2021 Reprint" historical document (id
-- 019f6e16-cac3-754d-9adb-efce9391f6e8), landed by migration
-- 20260717032755_encode_zoning_historical_backfill.sql.
--
-- Migration 20260717070000_fix_encode_zoning_historical_superseded_date.sql
-- already corrected ordinance_provisions.superseded_date on the 2 child rows
-- to 2023-05-10, but never touched this parent document's metadata field,
-- which still carried the original wrong claim: "zMOD comprehensive rewrite,
-- Ord. 19-19-112, effective 2021-12-02".
--
-- Verified independently (pi's audit, cross-checked here): the Virginia
-- Supreme Court's opinion in Berry v. Board of Supervisors of Fairfax
-- County, 884 S.E.2d 515 (Va. 2023), decided 2023-03-23, held the Board's
-- 2021-03-23 zMOD adoption (intended effective 2021-07-01) VOID AB INITIO
-- for a FOIA violation (adopted at a virtual meeting with no valid
-- in-person hearing). Fairfax County's own site acknowledged the effect was
-- reinstatement of the 1978 Zoning Ordinance. The Board then validly
-- readopted the modernized ordinance in person on 2023-05-09, repealing
-- Chapter 112 and adopting Chapter 112.2, effective 2023-05-10 -- matches
-- our own ingested Amendment History Table (chunk
-- 019f4c56-664d-775d-b22a-38993c6abc77). "Ord. 19-19-112" is confirmed
-- fabricated/unverifiable -- no source corroborates it, so it is dropped
-- rather than replaced with a guessed real ordinance number.
--
-- This migration updates only the superseded_by string inside
-- raw_api_response; content_hash/effective_date/title/url and the 2 child
-- ordinance_provisions rows are untouched.

DO $$
DECLARE
  doc_id uuid := '019f6e16-cac3-754d-9adb-efce9391f6e8';
  old_value text := 'zMOD comprehensive rewrite, Ord. 19-19-112, effective 2021-12-02';
  new_value text := 'Chapter 112.2 valid readoption, effective 2023-05-10 (2021 zMOD adoption declared void ab initio by Berry v. Board of Supervisors of Fairfax County, 884 S.E.2d 515 (Va. 2023))';
BEGIN
  -- Precondition: the document must exist exactly as backfilled, with the
  -- known-wrong superseded_by value, before touching anything.
  IF (
    SELECT count(*)
    FROM public.documents
    WHERE id = doc_id
      AND doc_type = 'encode_zoning'
      AND url = 'https://online.encodeplus.com/regs/fairfaxcounty-va/doclibrary.aspx?id=922528cd-6de4-4112-8678-79e8ed26a092'
      AND raw_api_response ->> 'superseded_by' = old_value
  ) <> 1 THEN
    RAISE NOTICE 'EnCode zoning document not in the expected pre-correction state -- skipping (idempotent; already corrected or state has changed)';
    RETURN;
  END IF;

  UPDATE public.documents
  SET raw_api_response = jsonb_set(
    raw_api_response,
    '{superseded_by}',
    to_jsonb(new_value)
  )
  WHERE id = doc_id
    AND raw_api_response ->> 'superseded_by' = old_value;

  -- Post-condition: the field now carries the corrected value, and every
  -- other key in raw_api_response is untouched.
  IF (
    SELECT count(*)
    FROM public.documents
    WHERE id = doc_id
      AND raw_api_response ->> 'superseded_by' = new_value
      AND raw_api_response ->> 'historical_backfill' = 'true'
      AND raw_api_response ->> 'source' = 'encode_archive_reprint'
      AND raw_api_response ->> 'reprint_date' = '2021-06-30'
  ) <> 1 THEN
    RAISE EXCEPTION 'Post-correction document metadata did not verify';
  END IF;
END $$;
