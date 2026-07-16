-- Re-file two historical Municode snapshots under their continuing current nodes.
--
-- PR #97 backfilled these rows before resolveHistoricalIdentity() loaded the
-- full current-row index. The corrected matcher groups these snapshots with
-- their current counterparts; only municode_node_id should change.

DO $$
DECLARE
  moved_count integer;
BEGIN
  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND is_current = false
      AND municode_node_id = 'THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4CHBAPRACLASTAC'
      AND effective_date = DATE '2026-01-16'
      AND section_title = 'Section 124.1-2-4. - Chesapeake Bay Preservation Act Land-Disturbing Activity.'
      AND content_hash = '68352fe068dd533b3e1e568a05989bb06ead0f9be38d11bdd2a7dedf2c75bf7f'
      AND embedding IS NOT NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one historical 124.1-2-4 Chesapeake Bay row under the old node id';
  END IF;

  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND is_current = true
      AND municode_node_id = 'THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4LASTACCHBAPRAR'
      AND effective_date = DATE '2026-04-28'
      AND section_title = 'Section 124.1-2-4. - Land-Disturbing Activity in Chesapeake Bay Preservation Areas.'
      AND content_hash = 'f0d83fd674114da272767fe47f4d078cfc6d08ae9910048930d56ccf507c1bbe'
      AND embedding IS NOT NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one current 124.1-2-4 row under the target node id';
  END IF;

  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND is_current = false
      AND municode_node_id = 'FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPEEFJU11989'
      AND effective_date = DATE '2025-04-25'
      AND section_title = 'Section 12-1-4. - Locks and peepholes. (Effective July 1, 1989)'
      AND content_hash = '13f5d1cc000b735d97fdafea587c23833e41863b7628036d16da99bc981bf4e2'
      AND embedding IS NOT NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one historical effective 12-1-4 row under the old node id';
  END IF;

  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND is_current = true
      AND municode_node_id = 'FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPE'
      AND effective_date = DATE '2026-04-28'
      AND section_title = 'Section 12-1-4. - Locks and peepholes.'
      AND content_hash = '1a42580044bf82673dfc56f6dc086c730b8166859710e361ea040a3202ee9642'
      AND embedding IS NOT NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one current 12-1-4 row under the target node id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND municode_node_id = 'THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4LASTACCHBAPRAR'
      AND effective_date = DATE '2026-01-16'
  ) THEN
    RAISE EXCEPTION 'Target 124.1-2-4 node already has a 2026-01-16 row';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND municode_node_id = 'FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPE'
      AND effective_date = DATE '2025-04-25'
  ) THEN
    RAISE EXCEPTION 'Target 12-1-4 node already has a 2025-04-25 row';
  END IF;

  BEGIN
    EXECUTE 'ALTER TABLE public.ordinance_provisions DISABLE TRIGGER trg_ordinance_provisions_updated_at';
    EXECUTE 'ALTER TABLE public.ordinance_provisions DISABLE TRIGGER ordinance_provisions_tsv';

    UPDATE public.ordinance_provisions
    SET municode_node_id = CASE
      WHEN municode_node_id = 'THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4CHBAPRACLASTAC'
        THEN 'THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4LASTACCHBAPRAR'
      WHEN municode_node_id = 'FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPEEFJU11989'
        THEN 'FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPE'
    END
    WHERE source_type = 'municode'
      AND is_current = false
      AND (
        (
          municode_node_id = 'THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4CHBAPRACLASTAC'
          AND effective_date = DATE '2026-01-16'
          AND section_title = 'Section 124.1-2-4. - Chesapeake Bay Preservation Act Land-Disturbing Activity.'
          AND content_hash = '68352fe068dd533b3e1e568a05989bb06ead0f9be38d11bdd2a7dedf2c75bf7f'
        )
        OR (
          municode_node_id = 'FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPEEFJU11989'
          AND effective_date = DATE '2025-04-25'
          AND section_title = 'Section 12-1-4. - Locks and peepholes. (Effective July 1, 1989)'
          AND content_hash = '13f5d1cc000b735d97fdafea587c23833e41863b7628036d16da99bc981bf4e2'
        )
      );

    GET DIAGNOSTICS moved_count = ROW_COUNT;

    EXECUTE 'ALTER TABLE public.ordinance_provisions ENABLE TRIGGER ordinance_provisions_tsv';
    EXECUTE 'ALTER TABLE public.ordinance_provisions ENABLE TRIGGER trg_ordinance_provisions_updated_at';
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'ALTER TABLE public.ordinance_provisions ENABLE TRIGGER ordinance_provisions_tsv';
    EXECUTE 'ALTER TABLE public.ordinance_provisions ENABLE TRIGGER trg_ordinance_provisions_updated_at';
    RAISE;
  END;

  IF moved_count <> 2 THEN
    RAISE EXCEPTION 'Expected to re-file exactly 2 historical rows, moved %', moved_count;
  END IF;

  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND municode_node_id = 'THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4CHBAPRACLASTAC'
  ) <> 0 THEN
    RAISE EXCEPTION 'Old historical 124.1-2-4 node still has rows after correction';
  END IF;

  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND municode_node_id = 'FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPEEFJU11989'
  ) <> 0 THEN
    RAISE EXCEPTION 'Old historical effective 12-1-4 node still has rows after correction';
  END IF;

  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND municode_node_id = 'THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4LASTACCHBAPRAR'
      AND is_current = true
  ) <> 1 OR (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND municode_node_id = 'THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4LASTACCHBAPRAR'
      AND is_current = false
      AND effective_date = DATE '2026-01-16'
      AND section_title = 'Section 124.1-2-4. - Chesapeake Bay Preservation Act Land-Disturbing Activity.'
  ) <> 1 THEN
    RAISE EXCEPTION 'Post-correction 124.1-2-4 target node grouping did not verify';
  END IF;

  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND municode_node_id = 'FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPE'
      AND is_current = true
  ) <> 1 OR (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND municode_node_id = 'FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPE'
      AND is_current = false
      AND effective_date = DATE '2025-04-25'
      AND section_title = 'Section 12-1-4. - Locks and peepholes. (Effective July 1, 1989)'
  ) <> 1 THEN
    RAISE EXCEPTION 'Post-correction 12-1-4 target node grouping did not verify';
  END IF;

  IF (
    SELECT count(*)
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
      AND municode_node_id = 'FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPEREEFJU11989'
      AND is_current = false
      AND effective_date = DATE '2025-04-25'
      AND section_title = 'Section 12-1-4. - Locks and peepholes. (Repealed, effective July 1, 1989)'
  ) <> 1 THEN
    RAISE EXCEPTION 'Unrelated repealed 12-1-4 historical row was not preserved as expected';
  END IF;
END $$;
