-- Corrects the one amendment_events row already written live by
-- amendment-resolution's first production run (the 1993-04-15 Gypsy Moth /
-- Appendix I Section 5 tax-rate case). Cross-vendor review of PR #105 found
-- that the original code blindly copied policy_decisions.vote_tally_id
-- into the new amendment_events row without verifying it actually
-- corresponded to the amendment being resolved.
--
-- Both vote_tallies rows sit on the same board-meeting document
-- (019f6993-35d9-7dff-83dd-466c2c20c248), which bundles several unrelated
-- votes:
--   019f6993-ba69-7290-bdc9-abd79cfb857f -- "Proclamation designating
--     'GIRL SCOUT LEADER'S DAY'" (WRONG -- this is what got linked)
--   019f6993-ba69-7b44-9d5e-822758c928a9 -- "Amendment to the Code of the
--     County of Fairfax, Appendix I, Fairfax County Special Service District
--     for the Control of Gypsy Moth Infestations, Section 5, to reduce tax
--     rate" (CORRECT -- this is the actual amendment vote)
--
-- The node resolution itself (Appendix I Section 5) was correct; only the
-- vote_tally_id link was wrong. This migration corrects vote_tally_id only.

DO $$
DECLARE
  fixed_count integer;
BEGIN
  -- Precondition: the row must exist exactly as the buggy code wrote it,
  -- with the wrong (Girl Scout) vote_tally_id, before touching anything.
  IF (
    SELECT count(*)
    FROM public.amendment_events
    WHERE id = '019f71ba-dd11-7289-9de0-768d43bd3c92'
      AND municode_node_id = 'THCOCOFAVI1976_APXIFACOSPSEDICOININMACADIISDAHUGYMOCACEIDPE_S5ANTALECOEXFU'
      AND vote_tally_id = '019f6993-ba69-7290-bdc9-abd79cfb857f'
  ) <> 1 THEN
    RAISE NOTICE 'Gypsy Moth amendment_events row not in the expected pre-correction state -- skipping (idempotent; already corrected or state has changed)';
    RETURN;
  END IF;

  -- Sanity check the target vote_tally is the one we expect before pointing at it.
  IF (
    SELECT count(*)
    FROM public.vote_tallies
    WHERE id = '019f6993-ba69-7b44-9d5e-822758c928a9'
      AND document_id = '019f6993-35d9-7dff-83dd-466c2c20c248'
      AND motion_text = 'Amendment to the Code of the County of Fairfax, Appendix I, Fairfax County Special Service District for the Control of Gypsy Moth Infestations, Section 5, to reduce tax rate'
  ) <> 1 THEN
    RAISE EXCEPTION 'Expected correct Gypsy Moth vote_tallies row not found -- aborting rather than pointing at the wrong thing';
  END IF;

  UPDATE public.amendment_events
  SET vote_tally_id = '019f6993-ba69-7b44-9d5e-822758c928a9'
  WHERE id = '019f71ba-dd11-7289-9de0-768d43bd3c92'
    AND vote_tally_id = '019f6993-ba69-7290-bdc9-abd79cfb857f';

  GET DIAGNOSTICS fixed_count = ROW_COUNT;

  IF fixed_count <> 1 THEN
    RAISE EXCEPTION 'Expected to correct exactly 1 row, corrected %', fixed_count;
  END IF;

  -- Post-condition: vote_tally_id corrected, node/dates/text untouched.
  IF (
    SELECT count(*)
    FROM public.amendment_events
    WHERE id = '019f71ba-dd11-7289-9de0-768d43bd3c92'
      AND municode_node_id = 'THCOCOFAVI1976_APXIFACOSPSEDICOININMACADIISDAHUGYMOCACEIDPE_S5ANTALECOEXFU'
      AND vote_tally_id = '019f6993-ba69-7b44-9d5e-822758c928a9'
      AND adopted_date = DATE '1993-04-15'
  ) <> 1 THEN
    RAISE EXCEPTION 'Post-correction amendment_events row did not verify';
  END IF;
END $$;
