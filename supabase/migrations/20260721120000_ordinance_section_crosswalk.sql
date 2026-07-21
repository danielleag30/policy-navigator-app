-- ordinance_section_crosswalk: bridges citation-numbering discontinuities so
-- point-in-time ("what were R1 setbacks in 2018") and delta ("how have R1
-- setbacks changed") queries can resolve across a renumbering boundary, most
-- notably zMOD's hard citation-numbering break between pre-2021 old-style
-- citations (e.g. 'Sec. 2-103') and post-zMOD new-style citations (e.g.
-- '4102.6.A(4)') -- see execution log's 2026-07-17 "Amendment-lifecycle / zMOD
-- crosswalk design investigation" entry.
--
-- Design: keyed by a conceptual canonical_topic_id (a human-assigned, stable
-- text label for "the same underlying rule over time"), NOT by node id --
-- because the whole point is to link rows whose municode_node_id can differ
-- across versions (zMOD's EnCode renumbering changes node id entirely; even
-- plain Municode chapter-to-chapter recodifications, e.g. Chapter 9.1 ->
-- Chapter 9.2 below, change node id). Each row maps one canonical_topic_id to
-- one specific ordinance_provisions row (by id, not by municode_node_id --
-- a node id alone does not uniquely identify a version, since historical and
-- current rows for the same node id are different provisions rows) valid for
-- a given citation string over a given date range.
--
-- Deviates from the log's original sketch in two ways, both verified against
-- the real schema/data rather than copied blindly:
--   1. References ordinance_provisions(id) (a specific version row), not
--      municode_node_id (text) -- node id alone is ambiguous across versions
--      and isn't a foreign key target anyway (no unique constraint on it
--      alone).
--   2. effective_date here is NOT always copied verbatim from the underlying
--      ordinance_provisions row. For Municode rows, effective_date reflects
--      Municode's own per-supplement codification date, which is a real and
--      meaningful per-provision date -- copied as-is. But EnCode zoning
--      current rows use a documented ingestion-time placeholder
--      (encode.ts's defaultEffectiveDate() = today+1, NOT a real per-section
--      date -- EnCode does not publish one), so for the 2 zoning topics below
--      this column uses the independently-verified real legal date
--      (2023-05-10, Chapter 112.2's valid readoption -- see the historical
--      backfill migration 20260717032755 for the full sourcing) instead.

CREATE TABLE ordinance_section_crosswalk (
  id                      uuid PRIMARY KEY,
  canonical_topic_id      text NOT NULL,
  ordinance_provision_id  uuid NOT NULL REFERENCES ordinance_provisions(id) ON DELETE CASCADE,
  citation_at_date        text NOT NULL,
  effective_date          date NOT NULL,
  superseded_date         date NULL,
  source_type             text NOT NULL CHECK (source_type IN ('municode', 'encode_zoning')),
  notes                   text NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ordinance_section_crosswalk_provision_id_key
    UNIQUE (ordinance_provision_id),
  CONSTRAINT ordinance_section_crosswalk_dates_check
    CHECK (superseded_date IS NULL OR superseded_date > effective_date)
);

CREATE INDEX ordinance_section_crosswalk_topic_id_idx
  ON ordinance_section_crosswalk (canonical_topic_id);

CREATE INDEX ordinance_section_crosswalk_effective_date_idx
  ON ordinance_section_crosswalk (effective_date);

CREATE INDEX ordinance_section_crosswalk_superseded_date_idx
  ON ordinance_section_crosswalk (superseded_date)
  WHERE superseded_date IS NOT NULL;

-- Mirrors ordinance_provisions_one_current_per_node_idx's pattern: at most one
-- still-current (superseded_date IS NULL) mapping per topic.
CREATE UNIQUE INDEX ordinance_section_crosswalk_one_current_per_topic_idx
  ON ordinance_section_crosswalk (canonical_topic_id)
  WHERE superseded_date IS NULL;

ALTER TABLE ordinance_section_crosswalk ENABLE ROW LEVEL SECURITY;

-- Point-in-time lookup: the crosswalk row for a topic that was in force on a
-- given date (effective_date <= p_as_of AND (superseded_date IS NULL OR
-- superseded_date > p_as_of)), joined with its ordinance_provisions content.
CREATE OR REPLACE FUNCTION get_crosswalk_citation_at(p_topic_id text, p_as_of date)
RETURNS TABLE(
  canonical_topic_id  text,
  citation_at_date    text,
  effective_date      date,
  superseded_date     date,
  source_type         text,
  ordinance_provision_id uuid,
  municode_node_id    text,
  section_title       text,
  content             text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    cw.canonical_topic_id,
    cw.citation_at_date,
    cw.effective_date,
    cw.superseded_date,
    cw.source_type,
    cw.ordinance_provision_id,
    op.municode_node_id,
    op.section_title,
    op.content
  FROM ordinance_section_crosswalk cw
  JOIN ordinance_provisions op ON op.id = cw.ordinance_provision_id
  WHERE cw.canonical_topic_id = p_topic_id
    AND cw.effective_date <= p_as_of
    AND (cw.superseded_date IS NULL OR cw.superseded_date > p_as_of)
  ORDER BY cw.effective_date DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION get_crosswalk_citation_at(text, date) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION get_crosswalk_citation_at(text, date) TO service_role;

-- Delta lookup: full version history for a topic, oldest first, joined with
-- ordinance_provisions content -- lets a caller show how a provision changed
-- over time without a second round trip per version.
CREATE OR REPLACE FUNCTION get_crosswalk_history(p_topic_id text)
RETURNS TABLE(
  canonical_topic_id  text,
  citation_at_date    text,
  effective_date      date,
  superseded_date     date,
  source_type         text,
  ordinance_provision_id uuid,
  municode_node_id    text,
  section_title       text,
  content             text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    cw.canonical_topic_id,
    cw.citation_at_date,
    cw.effective_date,
    cw.superseded_date,
    cw.source_type,
    cw.ordinance_provision_id,
    op.municode_node_id,
    op.section_title,
    op.content
  FROM ordinance_section_crosswalk cw
  JOIN ordinance_provisions op ON op.id = cw.ordinance_provision_id
  WHERE cw.canonical_topic_id = p_topic_id
  ORDER BY cw.effective_date ASC;
$$;

REVOKE ALL ON FUNCTION get_crosswalk_history(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION get_crosswalk_history(text) TO service_role;

-- Backfill: real, independently-verified old/new provision pairs for the same
-- underlying rule, drawn from two already-audited sources --
--   (a) the 2 zMOD zoning provisions backfilled in migration 20260717032755
--       (ADU standards, Home Occupations -- PR #101), matched to their real
--       current-ordinance successor by direct content comparison (both old
--       and new text read and compared here, not just title similarity -- the
--       old citations use pre-zMOD "Sect. N-NNN" numbering, the new citations
--       use post-zMOD "NNNN.N.X" numbering per Article 4's Use Standards);
--   (b) 19 of the real historical Municode amendments verified across PR
--       #91/#97/#98 and cross-vendor audited again during DAN-119/120
--       eval-case authoring (PR #99/#104) -- each pair's ids, dates, and
--       content differences were independently re-confirmed against the live
--       ordinance_provisions table before writing this migration (not copied
--       blindly from eval notes).
--
-- Deliberately EXCLUDED (verified NOT to be real continuations, so not
-- crosswalked -- see eval/cases/adversarial-near-miss.json for the full
-- reasoning on each):
--   - Chapter 28 (massage establishments) and Chapter 29 (real estate
--     salesman): fully repealed, no successor text exists at all.
--   - Section 23-1-5 "Limitation on amount of bonds": citation number was
--     reassigned to a wholly unrelated new provision ("Compliance with law")
--     after repeal -- a coincidental citation reuse, not a renumbering.
--   - Section 23-1-6 "Monthly report": repealed with no successor ("Reserved").
--   - The 1989-repealed Section 12-1-4 variant (node
--     FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPEREEFJU11989): shares its citation
--     number with the current section by coincidence, but is a wholly
--     different, long-defunct tenant-request-triggered regime.
--
-- Also out of scope, disclosed rather than silently skipped: the live corpus
-- has ~86 municode_node_id groups where a historical row's content_hash
-- differs from its current counterpart, of which only a curated, individually
-- verified subset (the 19 below) has actually been read and confirmed as a
-- genuine same-topic amendment rather than pipeline noise or an unrelated
-- change. Expanding this backfill to the remaining candidates is a follow-up,
-- not attempted here to avoid grouping pairs nobody has actually read.
--
-- Idempotent: guarded on canonical_topic_id so re-running this migration
-- after a partial apply does not duplicate rows.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ordinance_section_crosswalk WHERE canonical_topic_id = 'cable.franchise_requirement'
  ) THEN
    RAISE NOTICE 'ordinance_section_crosswalk backfill already applied -- skipping (idempotent)';
    RETURN;
  END IF;

  INSERT INTO ordinance_section_crosswalk
    (id, canonical_topic_id, ordinance_provision_id, citation_at_date, effective_date, superseded_date, source_type, notes)
  VALUES
    -- Cable Television franchise (Chapter 9.1 -> Chapter 9.2, Ord. 35-19-9.2, effective 2020-01-01)
    ('019f8549-f415-778b-ac62-0c0469d103fb', 'cable.franchise_requirement', '019f4c15-1571-7623-b778-e09762462260', 'Sec. 9.1-3-1', DATE '2019-09-11', DATE '2019-11-19', 'municode', 'Requirement of a Franchise. Chapter 9.1 (Communications) repealed/replaced by Chapter 9.2 (Cable Television) via Ord. 35-19-9.2, effective 2020-01-01.'),
    ('019f8549-f417-7845-9f0a-b3de5a4ad3a2', 'cable.franchise_requirement', '019f34bb-569d-7bbd-9876-bfaa630d745c', 'Sec. 9.2-3-1', DATE '2026-04-28', NULL, 'municode', 'Requirement of a franchise (current, renumbered from 9.1-3-1).'),

    ('019f8549-f418-753a-8e63-8ff92bc500fb', 'cable.franchise_fee', '019f4c15-8a79-78b1-82e9-02ebb8d84c35', 'Sec. 9.1-5-8', DATE '2019-09-11', DATE '2019-11-19', 'municode', 'Franchise fee -- old text mandated a flat 5% fee.'),
    ('019f8549-f419-7951-8300-96129f2144c1', 'cable.franchise_fee', '019f34bb-93d4-7b06-9ff9-c9dc84103b87', 'Sec. 9.2-7-1', DATE '2026-04-28', NULL, 'municode', 'Payments by grantees (current, renumbered from 9.1-5-8) -- fee is now conditional on state law (Virginia Communications Sales and Use Tax applies instead), not a flat mandatory fee.'),

    -- Tenant-Landlord (Chapter 12), Ord. 05-25-12
    ('019f8549-f41a-7618-b158-2063a9448a10', 'tenant_landlord.lock_peephole_requirement', '019f692e-d67a-7f2f-8a4b-e3e6f7f8dfbe', 'Sec. 12-1-4', DATE '2025-04-25', DATE '2025-07-11', 'municode', 'Locks and peepholes -- old trigger clause was "any one building".'),
    ('019f8549-f41c-73f7-8536-1d34d2219c54', 'tenant_landlord.lock_peephole_requirement', '019f34bc-a37a-7a38-9c7d-a98060fca273', 'Sec. 12-1-4', DATE '2026-04-28', NULL, 'municode', 'Locks and peepholes (current) -- trigger narrowed to "any one (1) multifamily building", adds Va. Code Sec. 36-97 et seq. cross-reference.'),

    ('019f8549-f41d-7b1b-9ddd-177c75e5e0b4', 'tenant_landlord.definitions', '019f692e-cf91-7ef8-b3fe-3f2b58bce33a', 'Sec. 12-1-1', DATE '2025-04-25', DATE '2025-07-11', 'municode', 'Definitions -- included a definition of "the Commission" (Fairfax County Tenant-Landlord Commission).'),
    ('019f8549-f41e-7388-b325-82d5c954bce9', 'tenant_landlord.definitions', '019f34bc-9eaa-77a8-8ccc-26a31fea9b01', 'Sec. 12-1-1', DATE '2026-04-28', NULL, 'municode', 'Definitions (current) -- Commission definition deleted (Reserved); the Commission was eliminated.'),

    ('019f8549-f41f-7615-bf00-0b83d91eff1d', 'tenant_landlord.commission_signage_requirement', '019f692e-d113-7416-9b56-bc1b76be16c9', 'Sec. 12-1-2', DATE '2025-04-25', DATE '2025-07-11', 'municode', 'Signs in office of landlord -- old text named the Tenant-Landlord Commission and Dept. of Consumer Affairs.'),
    ('019f8549-f421-7615-a7a5-1fb0752d9e90', 'tenant_landlord.commission_signage_requirement', '019f34bc-a02e-7fe3-949f-c126c498871e', 'Sec. 12-1-2', DATE '2026-04-28', NULL, 'municode', 'Signs in office of landlord (current) -- renamed to Department of Cable and Consumer Services.'),

    -- Animal Control (Chapter 41.1), Ord. 11-25-41.1 renaming
    ('019f8549-f422-75e3-8111-a7cedd1209af', 'animal_control.shelter_fee_waiver', '019f6923-770e-751d-96aa-24cb957ba891', 'Sec. 41.1-2-5', DATE '2025-09-19', DATE '2026-01-16', 'municode', 'County animal shelter fee waiver -- old text names the "Animal Shelter Director".'),
    ('019f8549-f423-76cc-8105-569b0d77bba6', 'animal_control.shelter_fee_waiver', '019f34bf-99e4-7ed2-b335-653e345879bb', 'Sec. 41.1-2-5', DATE '2026-04-28', NULL, 'municode', 'County animal shelter fee waiver (current) -- renamed to "Director of Animal Services".'),

    ('019f8549-f424-708c-a62a-249a34f93835', 'animal_control.emergency_boarding_authorization', '019f6923-8808-7efb-8a05-157e4d9d535b', 'Sec. 41.1-2-16', DATE '2025-09-19', DATE '2026-01-16', 'municode', 'Burial or cremation of dead animals and fowl -- old text names "Animal Services Division".'),
    ('019f8549-f426-75ee-986e-1b72f9c23bfc', 'animal_control.emergency_boarding_authorization', '019f34bf-af23-7a81-9755-37547162ef4c', 'Sec. 41.1-2-16', DATE '2026-04-28', NULL, 'municode', 'Burial or cremation of dead animals and fowl (current) -- renamed to "Department of Animal Services".'),

    -- Alcohol (Chapter 5), Ord. 17-25-5
    ('019f8549-f427-7316-81ad-f1120bb80b54', 'alcohol.school_grounds_misdemeanor_penalty', '019f6923-cad3-7fcd-a957-0decfd75219b', 'Sec. 5-1-26', DATE '2025-09-19', DATE '2026-01-16', 'municode', 'Drinking/possession on public school grounds -- old text was a single-sentence misdemeanor penalty clause.'),
    ('019f8549-f428-7e60-a36e-84b105d2cd5b', 'alcohol.school_grounds_misdemeanor_penalty', '019f34ba-9207-7156-9105-8ca308feed9c', 'Sec. 5-1-26', DATE '2026-04-28', NULL, 'municode', 'Drinking/possession on public school grounds (current) -- rewritten into lettered subsections, adds sacramental-wine and performing-arts exceptions, reclassified as a Class 2 misdemeanor.'),

    ('019f8549-f42a-78d1-bd75-1cccee3ac8ed', 'alcohol.public_open_container_possession', '019f6923-c95b-70c7-80a3-67d1240bace7', 'Sec. 5-1-25', DATE '2025-09-19', DATE '2026-01-16', 'municode', 'Possession of open alcoholic beverage containers prohibited -- old text covered parks/playgrounds/streets only, no sidewalk.'),
    ('019f8549-f42b-7233-808d-52da01b3fad8', 'alcohol.public_open_container_possession', '019f6923-cc31-7f6b-85d1-c7d12eee4dbe', 'Sec. 5-1-27', DATE '2025-09-19', DATE '2026-01-16', 'municode', 'Drinking alcoholic beverages or tendering to another in public place; penalty -- this separate section was absorbed into Sec. 5-1-25 by Ord. 17-25-5 and has no current-row match of its own; grouped under the same topic as the section it was consolidated into.'),
    ('019f8549-f42c-7491-82d4-9230dd1527d2', 'alcohol.public_open_container_possession', '019f34ba-9064-7e57-85bc-8a6367fd7472', 'Sec. 5-1-25', DATE '2026-04-28', NULL, 'municode', 'Possession of open alcoholic beverage containers prohibited and penalty for drinking/tendering (current) -- Ord. 17-25-5 added sidewalk coverage and absorbed the old Sec. 5-1-27 drinking/tendering language into this section.'),

    -- Elections (Chapter 7)
    ('019f8549-f42d-7983-abef-57efa3e83636', 'elections.mount_vernon_precinct_list', '019f6923-9e18-70a8-a6ee-b5a7cdac6ccb', 'Sec. 7-2-9', DATE '2025-09-19', DATE '2026-01-16', 'municode', 'Mount Vernon District precinct list -- old list has no Montebello precinct.'),
    ('019f8549-f42f-7fe0-8fd9-93ccb77c796f', 'elections.mount_vernon_precinct_list', '019f34ba-fd3b-7978-80ac-069b4a8bff67', 'Sec. 7-2-9', DATE '2026-04-28', NULL, 'municode', 'Mount Vernon District precinct list (current) -- Montebello inserted as a new precinct, Ord. 13-25-7.'),

    -- Licensing (Chapters 21, 23)
    ('019f8549-f430-78f4-8c5e-7382d61bb368', 'licensing.auto_graveyard_renewal', '019f6927-4218-7d51-95ca-1616604e6de9', 'Sec. 21-1-2', DATE '2026-01-16', DATE '2026-04-28', 'municode', 'Automobile graveyard license required/fee -- old issuing office "Supervisor of Assessments", renewal deadline Jan 31, flat/percentage penalty.'),
    ('019f8549-f431-71d3-994a-aa1a8733e977', 'licensing.auto_graveyard_renewal', '019f34bc-faee-728f-a166-48fa3cd76ea3', 'Sec. 21-1-2', DATE '2026-04-28', NULL, 'municode', 'Automobile graveyard license required/fee (current), Ord. 33-25-21 -- issuing office renamed to "Director of the Department of Tax Administration", renewal deadline moved to March 1, penalty flat-rated to $10.00.'),

    ('019f8549-f433-7595-99cb-5db6633d5d13', 'licensing.bondsman_application_criteria', '019f6927-49b2-7e6d-ac01-787ae2e73be9', 'Sec. 23-1-2', DATE '2026-01-16', DATE '2026-04-28', 'municode', 'Bondsman license application; certificate of character -- old text required a county moral-character certificate.'),
    ('019f8549-f434-7f57-953f-e31571e4d11d', 'licensing.bondsman_application_criteria', '019f34bd-0802-7369-a931-880c429fba35', 'Sec. 23-1-2', DATE '2026-04-28', NULL, 'municode', 'Bondsman license application (current), Ord. 34-25-23 -- moral-character certificate replaced with a state DCJS bail-bondsman license requirement.'),

    ('019f8549-f435-7e10-9d27-fa0d5e226525', 'licensing.bondsman_issuing_authority', '019f6927-4b1c-7e74-aa90-199a038df002', 'Sec. 23-1-3', DATE '2026-01-16', DATE '2026-04-28', 'municode', 'Issuance of bondsman license -- old issuing office "Supervisor of Assessments".'),
    ('019f8549-f436-74b3-8b2f-94260df7d555', 'licensing.bondsman_issuing_authority', '019f34bd-099b-7456-8ed8-71ec04f0bdf9', 'Sec. 23-1-3', DATE '2026-04-28', NULL, 'municode', 'Issuance of bondsman license (current), Ord. 34-25-23 -- renamed to "Director of the Department of Tax Administration".'),

    -- Land development (Chapter 101 subdivision ordinance)
    ('019f8549-f438-75a3-be8c-fe538fdc6daf', 'land_development.construction_plan_review_timeline', '019f6927-32de-73e0-9ce0-8e7fbe32d037', 'Sec. 101-2-4', DATE '2026-01-16', DATE '2026-04-28', 'municode', 'Construction plan review window -- old initial-review window was 60 days, resubmission-review window was 45 days.'),
    ('019f8549-f439-7f6c-aebf-c391d19b5037', 'land_development.construction_plan_review_timeline', '019f34cd-cdc9-7344-9d3c-f964fec11fd3', 'Sec. 101-2-4', DATE '2026-04-28', NULL, 'municode', 'Construction plan review window (current), Ord. 29-25-101 -- initial-review window shortened to 40 days, resubmission window to 30 days, adds a new tiered process for third-or-subsequent resubmissions.'),

    -- Land development (Chapter 115 local hearing-notice rule)
    ('019f8549-f43a-7e1b-871e-06bde5cbf76f', 'land_development.public_hearing_procedures', '019f692c-3fa9-784e-b144-731d72eed6bd', 'Sec. 115-4-7', DATE '2024-11-19', DATE '2025-04-25', 'municode', 'Public hearing procedures -- old text specified its own local newspaper-publication rule.'),
    ('019f8549-f43b-7a6f-a350-1f2b45ef6bf0', 'land_development.public_hearing_procedures', '019f34d0-d6d7-7036-b533-f6c399abc27a', 'Sec. 115-4-7', DATE '2026-04-28', NULL, 'municode', 'Public hearing procedures (current), Ord. 39-24-115 -- local rule deleted, defers entirely to Va. Code Sec. 15.2-4405.'),

    -- Chesapeake Bay Preservation (Chapter 118, pre-VESMR)
    ('019f8549-f43d-764b-acee-f9290c925064', 'chesapeake_bay.definitions', '019f692c-0e1e-77dc-a196-fb2191f786f6', 'Sec. 118-1-6', DATE '2024-11-19', DATE '2025-04-25', 'municode', 'Definitions -- old list has no "Adaptation measure" or "Canopy tree" entries.'),
    ('019f8549-f43e-7a66-ab0a-06480bc79279', 'chesapeake_bay.definitions', '019f34d1-3113-7e95-bc34-feed63ad7d19', 'Sec. 118-1-6', DATE '2026-04-28', NULL, 'municode', 'Definitions (current), Ord. 31-24-118 -- adds "Adaptation measure", "Canopy tree", "Mature tree", "Nature-based solution", "Understory tree".'),

    ('019f8549-f43f-7f28-b85d-9cde01fb4fc6', 'chesapeake_bay.rpa_permitted_uses', '019f692c-2ad1-7b8a-877b-c483bdafeb7c', 'Sec. 118-2-1', DATE '2024-11-19', DATE '2025-04-25', 'municode', 'Allowed uses in Resource Protection Areas -- old list (a)-(e) has no adaptation-measures entry.'),
    ('019f8549-f441-713f-83d1-6f1c0c34add0', 'chesapeake_bay.rpa_permitted_uses', '019f34d1-3db8-77b4-8c4a-eb97d9f01490', 'Sec. 118-2-1', DATE '2026-04-28', NULL, 'municode', 'Allowed uses in Resource Protection Areas (current), Ord. 31-24-118 -- adds (f) Adaptation measures, updates stormwater cross-references to the new Chapter 124.1/VESMR.'),

    -- Chesapeake Bay / Erosion & Stormwater (Chapter 124.1, post-VESMR)
    ('019f8549-f442-70a3-b6d6-22aed49d8496', 'chesapeake_bay.land_disturbing_activity_registration', '019f6927-6a78-7fb9-8c9c-c79c1e7eb1dc', 'Sec. 124.1-2-4', DATE '2026-01-16', DATE '2026-04-28', 'municode', 'Land-disturbing activity registration exemption -- old text (node-id corrected by PR #98) keyed the exemption to state-permit issue date.'),
    ('019f8549-f443-7701-ab5f-612cd7dd2013', 'chesapeake_bay.land_disturbing_activity_registration', '019f34d2-440d-7b49-ac14-041cc75c7665', 'Sec. 124.1-2-4', DATE '2026-04-28', NULL, 'municode', 'Land-Disturbing Activity in Chesapeake Bay Preservation Areas (current), Ord. 36-25-124.1 -- exemption rewritten around a common-plan-of-development / acreage threshold instead.'),

    ('019f8549-f444-76df-baca-912427580b60', 'chesapeake_bay.erosion_sediment_control_standard', '019f6927-7afa-744c-9c1a-cbf97b09d057', 'Sec. 124.1-6-3', DATE '2026-01-16', DATE '2026-04-28', 'municode', 'Erosion/sediment control minimum standards -- old text specified a local 202-cubic-yard-per-acre RPA storage override.'),
    ('019f8549-f446-717e-bfeb-835b98dfe89b', 'chesapeake_bay.erosion_sediment_control_standard', '019f34d2-8b53-746d-98b4-a5e66c0b92b4', 'Sec. 124.1-6-3', DATE '2026-04-28', NULL, 'municode', 'Erosion/sediment control minimum standards (current), Ord. 36-25-124.1 -- local override number deleted; defers to the state VESM Regulation / Stormwater Management Handbook / PFM.'),

    -- zMOD zoning renumbering (PR #101): pre-zMOD "Sect. N-NNN" -> post-zMOD "NNNN.N.X"
    -- New-side effective_date uses the verified real Chapter 112.2 readoption
    -- date (2023-05-10), not the current row's ingestion-time placeholder
    -- effective_date (see header comment).
    ('019f8549-f447-73bb-8078-934804662d9b', 'zoning.accessory_dwelling_unit', '019f6e16-cac6-797e-a372-83f5e28a9cd5', 'Sect. 8-918', DATE '2021-06-30', DATE '2023-05-10', 'encode_zoning', 'Additional Standards for Accessory Dwelling Units (pre-zMOD, 1978 Ordinance) -- BZA special-permit-only, 35% of principal dwelling gross floor area cap, required an elderly (55+) or disabled occupant, 5-year permit expiration.'),
    ('019f8549-f448-7253-b052-5f43640ab1d4', 'zoning.accessory_dwelling_unit', '019f4c4c-7e79-7815-a2c0-a64f421fd20d', '4102.7.B', DATE '2023-05-10', NULL, 'encode_zoning', 'Accessory Living Unit (current, post-zMOD) -- administrative-permit-by-default (special permit only for a larger unit), lesser of 800 sq ft or 40% of gross floor area cap, no age/disability occupancy requirement, no permit expiration. Matched to the pre-zMOD row by direct content comparison, not title similarity alone -- verified this is the substantive successor, not the coarser parent "4102.7 Accessory Uses" section (id 019f4c4c-7368-74e9-9e28-946612b06d8b) some eval-case notes loosely cited.'),

    ('019f8549-f449-7efd-bcd9-bb66646790a2', 'zoning.home_occupation', '019f6e16-cac8-77f7-8653-3c0f5eacfc9c', 'Sect. 10-301--10-305', DATE '2021-06-30', DATE '2023-05-10', 'encode_zoning', 'Home Occupations (pre-zMOD, 1978 Ordinance) -- permitted list limited to named trades, no explicit square-footage cap, barbershops/beauty parlors flatly prohibited.'),
    ('019f8549-f44b-72e2-ad80-2ffdea177a0e', 'zoning.home_occupation', '019f4c4c-a1bf-7680-8c84-b79a23bdbfb1', '4102.7.H', DATE '2023-05-10', NULL, 'encode_zoning', 'Home-Based Business (current, post-zMOD) -- different permitted-use list, explicit 400 sq ft cap, barbershops/hair salons now allowed with special permit approval. Matched to the pre-zMOD row by direct content comparison; old "Home Occupation" terminology no longer exists in the current ordinance.');

  RAISE NOTICE 'ordinance_section_crosswalk backfill inserted 43 rows across 21 canonical topics';
END $$;
