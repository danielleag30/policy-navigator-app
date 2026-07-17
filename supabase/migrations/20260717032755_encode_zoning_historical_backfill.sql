-- Targeted, one-time backfill: real pre-zMOD Fairfax County Zoning Ordinance
-- text for the two sections underlying 3 of the eval suite's remaining
-- zoning-temporal/adversarial cases (Accessory Dwelling Units and Home
-- Occupations). Source: EnCode Archives "2021 Reprint" (the last full reprint
-- of the pre-zMOD, 1978-descendant Zoning Ordinance, dated 2021-06-30, covering
-- amendments through ZO-21-488).
--
-- SUPERSEDED_DATE = 2023-05-10, NOT July/Dec 2021 -- verified against primary
-- sources (fairfaxcounty.gov news releases, ffxnow.com reporting) plus our own
-- ingested Amendment History Table (chunk 019f4c56-664d-775d-b22a-38993c6abc77):
-- the Board originally adopted zMOD on 2021-03-23 (effective 2021-07-01, as
-- Chapter 112.1), but the Virginia Supreme Court declared that adoption VOID
-- on 2023-03-23 for a FOIA violation (adopted at a mostly-virtual meeting with
-- no valid in-person hearing) -- the county reverted to the pre-zMOD 1978
-- Chapter 112 as the operative law ("the 1978 Zoning Ordinance is presently in
-- effect" per county spokesperson). The Board validly readopted the
-- modernized ordinance at an in-person hearing on 2023-05-09, repealing
-- Chapter 112 and adopting Chapter 112.2, effective 2023-05-10 (matches our
-- Amendment History Table row: "Repeal of Chapter 112 and adoption of Chapter
-- 112.2 ... Adoption Date 2023/05/09, Effective Date 2023/05/10"). Since a
-- void adoption is legally treated as never having occurred, the old Chapter
-- 112 text in this migration was validly, permanently superseded exactly
-- once -- 2023-05-10 -- not at either of the two 2021 dates various earlier
-- (unverified) notes had claimed.
--
-- This is NOT the recurring EnCode crawler (encode.ts) -- that crawler only
-- ever sees EnCode's current live tree and cannot reach pre-zMOD text at all
-- (confirmed dead end: EnCode's own "Historical Amendment Index" publishes
-- only dated section-change summaries, never old section bodies). The real
-- old text used here was extracted directly from the archived reprint PDF
-- (online.encodeplus.com/regs/fairfaxcounty-va/doclibrary.aspx?id=922528cd-
-- 6de4-4112-8678-79e8ed26a092), a one-time manual/admin action, following the
-- exact is_current=false / real effective_date pattern already cross-vendor
-- audited for the Municode historical backfill (PR #91/#97/#98). source_type
-- stays 'encode_zoning' (same value the 742 current EnCode rows use) --
-- historical vs. current is distinguished by is_current/effective_date/
-- superseded_date only, matching how Municode historical rows are
-- distinguished from Municode current rows.
--
-- Two rows (not a full chapter walk): Sect. 8-918 (Accessory Dwelling Unit
-- special-permit standards) and Article 10 Part 3 / Sect. 10-301 to 10-305
-- (Home Occupations). Both use a distinct 'encode:historical:*' node id
-- namespace with parent_node_id = NULL, since the pre-zMOD ordinance's
-- old-style section numbers (Sect. 8-918, Sect. 10-301) have no current
-- EnCode secid to attach to -- the zMOD rewrite is a hard citation-numbering
-- discontinuity, not a renumbering Municode-style identity resolution could
-- bridge.
--
-- Embeddings are intentionally left NULL here: the existing historical-
-- embedding retry backlog (handleMunicodeHistoricalEmbeddingRetry(), already
-- running on every ingest-orchestrator cron tick) picks up ANY is_current=false
-- row with a NULL embedding regardless of source_type, so these rows are
-- embedded via the same external HTTP embedding path as every other
-- historical row without any code change.

DO $$
DECLARE
  doc_id uuid := '019f6e16-cac3-754d-9adb-efce9391f6e8';
  adu_id uuid := '019f6e16-cac6-797e-a372-83f5e28a9cd5';
  ho_id uuid := '019f6e16-cac8-77f7-8653-3c0f5eacfc9c';
  reprint_url text := 'https://online.encodeplus.com/regs/fairfaxcounty-va/doclibrary.aspx?id=922528cd-6de4-4112-8678-79e8ed26a092';
BEGIN
  IF EXISTS (SELECT 1 FROM public.documents WHERE url = reprint_url) THEN
    RAISE NOTICE 'EnCode 2021 Reprint historical document already present -- skipping (idempotent)';
    RETURN;
  END IF;

  INSERT INTO public.documents (
    id, url, filename, doc_type, status, ingested_at, last_checked_at,
    content_hash, source_published_at, title, raw_api_response
  ) VALUES (
    doc_id,
    reprint_url,
    '2021-Reprint-with-Bookmarking.pdf',
    'encode_zoning',
    'superseded',
    now(),
    now(),
    'b869fa41790e28953a95ac3412b56c73707226091b2aef0e360e9a610ca39c7c',
    DATE '2021-06-30',
    'Fairfax County Zoning Ordinance -- 2021 Reprint (pre-zMOD, EnCode Archives)',
    jsonb_build_object(
      'historical_backfill', true,
      'source', 'encode_archive_reprint',
      'archive_page', 'https://online.encodeplus.com/regs/fairfaxcounty-va/archivedialog.aspx',
      'reprint_label', '2021 Reprint',
      'reprint_date', '2021-06-30',
      'superseded_by', 'Chapter 112.2 valid readoption, effective 2023-05-10 (2021 zMOD adoption later declared void by VA Supreme Court)',
      'note', 'One-time targeted backfill for eval cases requiring pre-zMOD zoning text (old-style citations); not part of the recurring EnCode crawler.'
    )
  );

  INSERT INTO public.ordinance_provisions (
    id, document_id, municode_node_id, parent_node_id, depth,
    effective_date, is_current, superseded_date, section_title,
    content, content_hash, source_type
  ) VALUES (
    adu_id,
    doc_id,
    'encode:historical:8-918',
    NULL,
    1,
    DATE '2021-06-30',
    false,
    DATE '2023-05-10',
    'Sect. 8-918 Additional Standards for Accessory Dwelling Units (pre-zMOD, 1978 Ordinance)',
    $ADU$8-918 Additional Standards for Accessory Dwelling Units
As established by the Fairfax County Board of Supervisors' Policy on Accessory Dwelling
Units (Appendix 5), the BZA may approve a special permit for the establishment of an
accessory dwelling unit with a single family detached dwelling unit but only in accordance with
the following conditions:
1. Accessory dwelling units shall only be permitted in association with a single family
detached dwelling unit and there shall be no more than one accessory dwelling unit per
single family detached dwelling unit.
2. Except on lots two (2) acres or larger, an accessory dwelling unit shall be located within
the structure of a single family detached dwelling unit. Any external entrances for the
accessory dwelling unit shall be located on the side or rear of the structure, unless an
alternative location is approved by the BZA.
On lots two (2) acres or greater in area, an accessory dwelling unit may be located
within the structure of a single family detached dwelling unit or within a freestanding
accessory structure.
3. The gross floor area of the accessory dwelling unit shall not exceed thirty-five (35)
percent of the total gross floor area of the principal dwelling unit. When the accessory
dwelling unit is located in a freestanding accessory structure, the gross floor area of the
accessory dwelling unit shall not exceed thirty-five (35) percent of the gross floor area of
the accessory freestanding structure and the principal dwelling unit.
4. The accessory dwelling unit shall contain not more than two (2) bedrooms.
5. The occupancy of the accessory dwelling unit and the principal dwelling unit shall be in
accordance with the following:
A. One of the dwelling units shall be owner occupied.
B. One of the dwelling units shall be occupied by a person or persons who qualify as
elderly and/or disabled as specified below:
(1) Any person fifty-five (55) years of age or over and/or
(2) Any person permanently and totally disabled. If the application is made in
reference to a person because of permanent and total disability, the
application shall be accompanied by a certification by the Social Security
Administration, the Veterans Administration or the Railroad Retirement
Board. If such person is not eligible for certification by any of these
agencies, there shall be submitted a written declaration signed by two (2)
medical doctors licensed to practice medicine, to the effect that such person
is permanently and totally disabled. The written statement of at least one of
the doctors shall be based upon a physical examination of the person by the
doctor. One of the doctors may submit a written statement based upon
medical information contained in the records of the Civil Service
Commission which is relevant to the standards for determining permanent
and total disability.
For purposes of this Section, a person shall be considered
permanently and totally disabled if such person is certified as required by
this Section as unable to engage in any substantial gainful activity by
reasons of any medically determinable physical or mental impairment or
deformity which can be expected to result in death or can be expected to last
for the duration of the person's life.
C. The accessory dwelling unit may be occupied by not more than two (2) persons
not necessarily related by blood or marriage. The principal single family dwelling
unit may be occupied by not more than one (1) of the following:
(1) One (1) family, which consists of one (1) person or two (2) or more persons
related by blood or marriage and with any number of natural children, foster
children, step children or adopted children.
(2) A group of not more than four (4) persons not necessarily related by blood
or marriage.
6. Any accessory dwelling unit established for occupancy by a disabled person shall
provide for reasonable access and mobility as required for the disabled person. The
measures for reasonable access and mobility shall be specified in the application for
special permit. Generally, reasonable access and mobility for physically disabled persons
shall include:
A. Uninterrupted access to one (1) entrance; and
B. Accessibility and usability of one (1) toilet room.
7. The BZA shall review all existing and/or proposed parking to determine if such parking
is sufficient to meet the needs of the principal and accessory dwelling units. If it is
determined that such parking is insufficient, the BZA may require the provision of one
(1) or more off-street parking spaces. Such parking shall be in addition to the
requirements specified in Article 11 for a single family dwelling unit.
8. The BZA shall determine that the proposed accessory dwelling unit together with any
other accessory dwelling unit(s) within the area will not constitute sufficient change to
modify or disrupt the predominant character of the neighborhood. In no instance shall
the approval of a special permit for an accessory dwelling unit be deemed a subdivision
of the principal dwelling unit or lot.
9. Any accessory dwelling unit shall meet the applicable regulations for building, safety,
health and sanitation.
10. Upon the approval of a special permit, the Clerk to the Board of Zoning Appeals shall
cause to be recorded among the land records of Fairfax County a copy of the BZA's
approval, including all accompanying conditions. Said resolution shall contain a
description of the subject property and shall be indexed in the Grantor Index in the name
of the property owners.
11. The owner shall make provisions to allow inspections of the property by County
personnel during reasonable hours upon prior notice.
12. Special permits for accessory dwelling units shall be approved for a period not to exceed
five (5) years from the date of approval; provided, however, that such special permits
may be extended for succeeding five (5) year periods in accordance with the provisions
of Sect. 012 above.
13. Notwithstanding Par. 2 of Sect. 011 above, all applications shall be accompanied by
fifteen (15) copies of a plat and such plat shall be presented on a sheet having a
maximum size of 24" x 36", and, in addition to the 15 copies, one 8 ½" x 11" reduction
of the plat. Such plat shall be drawn to a designated scale of not less than one inch
equals fifty feet (1" = 50'), unless a smaller scale is required to accommodate the
development. Such plat shall be certified by a professional engineer, land surveyor,
architect, or landscape architect licensed by the State of Virginia. Such plat shall contain
the following information:
A. Boundaries of entire property, with bearings and distances of the perimeter
property lines, and of each zoning district.
B. Total area of the property and of each zoning district in square feet or acres.
C. Scale and north arrow, with north, to the extent feasible, oriented to the top of the
plat and on all supporting graphics.
D. The location, dimension and height of any building or structure, to include existing
or proposed fences and/or walls and, if known, the construction date(s) of all
existing structures.
E. All required minimum yards to include front, side and rear, a graphic depiction of
the angle of bulk plane, if applicable, and the distances from all existing and/or
proposed structures to lot lines.
F. Means of ingress and egress to the property from a public street(s).
G. The location of a well and/or septic field, or indication that the property is served
by public water and/or sewer.
H. Location of all existing utility easements having a width of twenty-five (25) feet or
more, and all major underground utility easements regardless of width.
I. Seal and signature of the licensed professional person certifying the plat.
14. All applications shall be accompanied by a dimensioned floor plan depicting the internal
layout and gross floor area of both the principal and accessory dwelling unit, with the use
of each room and points of ingress and egress to the dwellings clearly labeled. The gross
floor area calculation shall include the limitation set forth in Par. 3 above. In addition,
and notwithstanding Par. 4 of Sect. 011 above, the dimensioned floor plan shall also be
accompanied by corresponding digital photographs, which shall be clearly dated and
labeled as to their subject matter.$ADU$,
    'eb6d67db2fe3dc4041919bbb673c81a3bf667cd3903dc524f119b13fe0c70875',
    'encode_zoning'
  );

  INSERT INTO public.ordinance_provisions (
    id, document_id, municode_node_id, parent_node_id, depth,
    effective_date, is_current, superseded_date, section_title,
    content, content_hash, source_type
  ) VALUES (
    ho_id,
    doc_id,
    'encode:historical:10-300',
    NULL,
    1,
    DATE '2021-06-30',
    false,
    DATE '2023-05-10',
    'Article 10, Part 3 (Sect. 10-301 - 10-305) Home Occupations (pre-zMOD, 1978 Ordinance)',
    $HO$PART 3 10-300 HOME OCCUPATIONS
10-301 Authorization
Home occupations are permitted in any dwelling unit subject to the approval by the Zoning
Administrator and the provisions listed below. An application for a home occupation shall be
filed with the Zoning Administrator on forms furnished by the County. The application for a
home occupation shall be accompanied by a filing fee of fifty dollars ($50) made payable to the
County of Fairfax.
10-302 Permitted Home Occupations
Home occupations include, but are not necessarily limited to, the following:
1. Artists and sculptors.
2. Authors and composers.
3. Dressmakers, seamstresses and tailors.
4. Home crafts, such as model making, rug weaving, lapidary work, and ceramics.
5. Office facilities, other than home professional offices as defined in Article 20.
6. Schools of special education whose class size does not exceed more than four (4) pupils
at any given time and not more than eight (8) pupils in any one day.
7. The letting for hire of not more than two (2) rooms for rooming or boarding use for not
more than two (2) persons, neither of whom is a transient.
8. Horseback riding lessons, in accordance with the following limitations:
A. On lots containing a minimum of two (2) acres but less than five (5) acres, no
more than two (2) students at any given time and up to eight (8) students in any
one day.
B. On lots containing five (5) acres or more, a maximum of four (4) students at any
given time and up to eight (8) students in any one day.
10-303 Home Occupations Not Permitted
Permitted home occupations shall not in any event be deemed to include the following:
1. Antique shops.
2. Barbershops or beauty parlors.
3. Restaurants.
4. Gift shops.
5. Repair service or personal service establishments, except as may be permitted by Sect.
302 above.
6. Kennels.
7. Veterinary hospitals.
10-304 Use Limitations
In addition to the use limitations applicable in the zoning district in which located, all home
occupations shall be subject to the following use limitations:
1. A home occupation must be conducted by the home occupation permit applicant within
the dwelling which is the primary residence of the applicant or in an accessory building
thereto which is normally associated with a residential use and shall be clearly
subordinate to the principal use of the lot as a dwelling.
2. Except for articles produced on the premises, no stock in trade shall be stored, displayed
or sold on the premises.
3. There shall be no exterior evidence that the property is used in any way other than for a
dwelling.
4. No mechanical or electrical equipment shall be employed other than machinery or
equipment customarily found in the home, associated with a hobby or avocation not
conducted for gain or profit, or customary for a small office.
5. No outside display or storage of goods, equipment or materials used in connection with
the home occupation shall be permitted.
6. The home occupation permit applicant and other persons who use the dwelling as their
primary residence may be involved in the home occupation use. In addition, one (1)
nonresident person, whether paid or not for their services, may be involved in the home
occupation use on the property provided that there is only one (1) such person on the
property and the hours of such attendance shall be limited to 8:00 AM to 5:00 PM,
Monday through Friday.
7. Only one commercial vehicle shall be permitted per dwelling unit, subject to the
provisions of Sect. 102 above.
8. The dwelling in which the home occupation is being conducted shall be open for
inspection to County personnel during reasonable hours.
9. A permit for a home occupation is valid for only the original applicant and is not
transferable to any resident, address or any other occupation. Upon termination of the
applicant's residency, the home occupation permit shall become null and void.
10. No sign shall be permitted, and all outdoor lighting shall be in accordance with Part 9 of
Article 14.
11. Except for schools of special education and horseback riding lessons as permitted in Sect.
302 above, there shall be no customers or clients.
12. In addition to Paragraphs 1 through 11 above, horseback riding lessons shall be subject to
the following:
A. Notwithstanding Par.1 above, the primary residence of the home occupation permit
applicant shall be located on the same lot where the horseback riding lessons are given;
however the applicant shall not be required to conduct the horseback riding lessons
and/or care for the horses that are kept, boarded or maintained on the property.
B. The hours of horseback riding lessons shall be limited to 7:00 AM to 7:00 PM and
notwithstanding Par. 6 above, one (1) nonresident person, whether paid or not for their
services, may assist with the horseback riding lessons and/or care for the horses, provided
that the hours of such attendance shall be limited to 7:00 AM to 7:00 PM.
C. All horses used in the horseback riding lessons shall be kept on the property and no
horses shall be transported or ridden onto the property for the lessons.
D. If there is a lighted outdoor riding ring or riding area, the use of outdoor lighting for such
areas shall be limited to 7:00 AM to 7:00 PM.
E. A Conservation Plan approved by the Northern Virginia Soil and Water Conservation
District shall be prepared for the property and all activity on the property shall conform
to such Plan.
Riding lessons, other than as permitted above, shall be deemed a riding/boarding stable and
shall require special permit approval in those districts where permitted.
10-305 Revocation of a Home Occupation Permit
A permit for a home occupation shall be revocable by the Zoning Administrator because of the
failure of the owner or operator of the use covered by the permit to observe all requirements of
the permit and the Zoning Ordinance.$HO$,
    '45be668f4b3142e397186c542fbd5d400d9c6b9f93eced29f25870d538596ec1',
    'encode_zoning'
  );
END $$;
