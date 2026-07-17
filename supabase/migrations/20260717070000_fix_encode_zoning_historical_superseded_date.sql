-- Corrects superseded_date on the 2 EnCode zoning historical rows landed by
-- migration 20260717032755_encode_zoning_historical_backfill.sql (Sect. 8-918
-- Accessory Dwelling Units, Article 10 Part 3 Home Occupations).
--
-- That migration used superseded_date = 2021-12-02, based on an unverified
-- (and wrong) claim in the original 2026-06-25 domain-knowledge doc that the
-- zMOD comprehensive rewrite took effect "Dec 2, 2021 (Ord. 19-19-112)". A
-- second, also-unverified claim proposed "July 1, 2021" as the correction.
-- Neither is right. Verified directly against primary sources
-- (fairfaxcounty.gov news releases, ffxnow.com reporting) plus our own
-- ingested Amendment History Table (chunk 019f4c56-664d-775d-b22a-38993c6abc77):
--
--   1. The Board adopted zMOD on 2021-03-23, intended effective 2021-07-01,
--      as Chapter 112.1.
--   2. The Virginia Supreme Court declared that adoption VOID on 2023-03-23
--      (FOIA violation -- adopted at a mostly-virtual meeting with no valid
--      in-person hearing). The county reverted to the pre-zMOD 1978 Chapter
--      112 as the operative law ("the 1978 Zoning Ordinance is presently in
--      effect" per county spokesperson) -- i.e. the exact text in the 2
--      rows this migration corrects became the current law again.
--   3. The Board validly readopted the modernized ordinance at an in-person
--      hearing on 2023-05-09, repealing Chapter 112 and adopting Chapter
--      112.2, effective 2023-05-10 (matches our Amendment History Table:
--      "Repeal of Chapter 112 and adoption of Chapter 112.2 ... Adoption
--      Date 2023/05/09, Effective Date 2023/05/10").
--
-- A void adoption is legally treated as never having occurred, so the old
-- Chapter 112 text was validly, permanently superseded exactly once --
-- 2023-05-10, not either 2021 date. This migration corrects superseded_date
-- only; content/effective_date/embeddings/node ids are untouched.

DO $$
DECLARE
  fixed_count integer;
BEGIN
  -- Precondition: both rows must exist exactly as backfilled, with the
  -- known-wrong date, before touching anything.
  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE id = '019f6e16-cac6-797e-a372-83f5e28a9cd5'
      AND municode_node_id = 'encode:historical:8-918'
      AND source_type = 'encode_zoning'
      AND is_current = false
      AND effective_date = DATE '2021-06-30'
      AND superseded_date = DATE '2021-12-02'
  ) <> 1 THEN
    RAISE NOTICE 'ADU historical row not in the expected pre-correction state -- skipping (idempotent; already corrected or state has changed)';
    RETURN;
  END IF;

  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE id = '019f6e16-cac8-77f7-8653-3c0f5eacfc9c'
      AND municode_node_id = 'encode:historical:10-300'
      AND source_type = 'encode_zoning'
      AND is_current = false
      AND effective_date = DATE '2021-06-30'
      AND superseded_date = DATE '2021-12-02'
  ) <> 1 THEN
    RAISE NOTICE 'Home Occupations historical row not in the expected pre-correction state -- skipping (idempotent; already corrected or state has changed)';
    RETURN;
  END IF;

  BEGIN
    EXECUTE 'ALTER TABLE public.ordinance_provisions DISABLE TRIGGER trg_ordinance_provisions_updated_at';

    UPDATE public.ordinance_provisions
    SET superseded_date = DATE '2023-05-10'
    WHERE id IN (
      '019f6e16-cac6-797e-a372-83f5e28a9cd5',
      '019f6e16-cac8-77f7-8653-3c0f5eacfc9c'
    )
      AND source_type = 'encode_zoning'
      AND is_current = false
      AND superseded_date = DATE '2021-12-02';

    GET DIAGNOSTICS fixed_count = ROW_COUNT;

    EXECUTE 'ALTER TABLE public.ordinance_provisions ENABLE TRIGGER trg_ordinance_provisions_updated_at';
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'ALTER TABLE public.ordinance_provisions ENABLE TRIGGER trg_ordinance_provisions_updated_at';
    RAISE;
  END;

  IF fixed_count <> 2 THEN
    RAISE EXCEPTION 'Expected to correct exactly 2 rows, corrected %', fixed_count;
  END IF;

  -- Post-condition: both rows now carry the corrected date, content/hash/
  -- embedding/node id untouched.
  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE id = '019f6e16-cac6-797e-a372-83f5e28a9cd5'
      AND municode_node_id = 'encode:historical:8-918'
      AND content_hash = 'eb6d67db2fe3dc4041919bbb673c81a3bf667cd3903dc524f119b13fe0c70875'
      AND is_current = false
      AND effective_date = DATE '2021-06-30'
      AND superseded_date = DATE '2023-05-10'
      AND embedding IS NOT NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'Post-correction ADU row did not verify';
  END IF;

  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE id = '019f6e16-cac8-77f7-8653-3c0f5eacfc9c'
      AND municode_node_id = 'encode:historical:10-300'
      AND content_hash = '45be668f4b3142e397186c542fbd5d400d9c6b9f93eced29f25870d538596ec1'
      AND is_current = false
      AND effective_date = DATE '2021-06-30'
      AND superseded_date = DATE '2023-05-10'
      AND embedding IS NOT NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'Post-correction Home Occupations row did not verify';
  END IF;
END $$;
