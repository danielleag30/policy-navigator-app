/**
 * Static-source-inspection tests for the ordinance_section_crosswalk
 * migration (supabase/migrations/20260721120000_ordinance_section_crosswalk.sql).
 * Matches this repo's existing convention for data/content correctness (see
 * tests/encode-zoning-historical-backfill.test.ts's file header) since no
 * live Supabase instance is available in CI -- this migration was already
 * applied directly to the hosted project and independently verified there
 * (43 rows / 21 topics counted live, get_crosswalk_citation_at and
 * get_crosswalk_history both live-verified for a zMOD zoning topic and a
 * same-node Municode topic); these tests guard the committed SQL against
 * silent regressions.
 */

const MIGRATION_PATH = "supabase/migrations/20260721120000_ordinance_section_crosswalk.sql";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readMigration(): Promise<string> {
  return await Deno.readTextFile(MIGRATION_PATH);
}

Deno.test("table is keyed by canonical_topic_id, references ordinance_provisions(id) (not municode_node_id), and has a one-row-per-provision constraint", async () => {
  const sql = await readMigration();
  assert(
    /CREATE TABLE ordinance_section_crosswalk/.test(sql),
    "expected a CREATE TABLE for ordinance_section_crosswalk",
  );
  assert(
    /canonical_topic_id\s+text NOT NULL/.test(sql),
    "expected canonical_topic_id text NOT NULL",
  );
  assert(
    /ordinance_provision_id\s+uuid NOT NULL REFERENCES ordinance_provisions\(id\) ON DELETE CASCADE/
      .test(sql),
    "expected a FK to ordinance_provisions(id) (a specific version row), not a bare municode_node_id text column",
  );
  assert(
    /ordinance_section_crosswalk_provision_id_key\s*\n\s*UNIQUE \(ordinance_provision_id\)/
      .test(sql),
    "expected a UNIQUE constraint on ordinance_provision_id so one provisions row cannot be double-mapped to two topics",
  );
  assert(
    sql.includes("CHECK (superseded_date IS NULL OR superseded_date > effective_date)"),
    "expected a date-ordering check constraint",
  );
});

Deno.test("indexes and RLS match the established ordinance_provisions convention", async () => {
  const sql = await readMigration();
  assert(
    sql.includes("CREATE INDEX ordinance_section_crosswalk_topic_id_idx"),
    "expected an index on canonical_topic_id",
  );
  assert(
    /CREATE UNIQUE INDEX ordinance_section_crosswalk_one_current_per_topic_idx\s*\n\s*ON ordinance_section_crosswalk \(canonical_topic_id\)\s*\n\s*WHERE superseded_date IS NULL/
      .test(sql),
    "expected a partial unique index enforcing at most one current (superseded_date IS NULL) row per topic, mirroring ordinance_provisions_one_current_per_node_idx",
  );
  assert(
    sql.includes("ALTER TABLE ordinance_section_crosswalk ENABLE ROW LEVEL SECURITY"),
    "expected RLS enabled, matching every other table in this schema",
  );
  assert(
    !/REVOKE ALL ON TABLE ordinance_section_crosswalk/.test(sql),
    "no explicit anon/authenticated REVOKE needed on the table itself -- anon has zero default table grants in this project (see 20260622120000_revoke_anon_all_tables.sql), matching the amendment_resolution_logs precedent",
  );
});

Deno.test("both read-helper functions are STABLE, SECURITY DEFINER, and locked down to service_role only", async () => {
  const sql = await readMigration();
  for (const fn of ["get_crosswalk_citation_at(text, date)", "get_crosswalk_history(text)"]) {
    // Postgres grants EXECUTE to PUBLIC by default on new functions, and
    // anon/authenticated are implicitly members of PUBLIC -- revoking from
    // anon/authenticated alone does NOT remove that default grant, so both
    // roles could still call the function unless PUBLIC is revoked too
    // (live-proven during cross-vendor review: anon/authenticated could call
    // both functions and read real ordinance_provisions content despite the
    // anon/authenticated-only revokes).
    assert(
      sql.includes(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`),
      `expected ${fn} to revoke the default PUBLIC execute grant -- REVOKE FROM anon, authenticated alone does not remove it, since both are members of PUBLIC`,
    );
    assert(
      sql.includes(`REVOKE ALL ON FUNCTION ${fn} FROM anon, authenticated`),
      `expected ${fn} to revoke anon/authenticated execute`,
    );
    assert(
      sql.includes(`GRANT EXECUTE ON FUNCTION ${fn} TO service_role`),
      `expected ${fn} to grant execute to service_role only`,
    );
  }
  assert(
    (sql.match(/SECURITY DEFINER/g) ?? []).length === 2,
    "expected exactly 2 SECURITY DEFINER functions (point-in-time + history), matching get_ordinance_ancestors' convention",
  );
  assert(
    sql.includes("effective_date <= p_as_of") &&
      sql.includes("(cw.superseded_date IS NULL OR cw.superseded_date > p_as_of)"),
    "expected the point-in-time function to correctly bracket effective_date/superseded_date around the query date",
  );
});

Deno.test("backfill is idempotency-guarded", async () => {
  const sql = await readMigration();
  assert(
    /IF EXISTS \(\s*SELECT 1 FROM ordinance_section_crosswalk WHERE canonical_topic_id = 'cable\.franchise_requirement'\s*\)/
      .test(sql),
    "expected an idempotency guard checking for a known topic before inserting",
  );
  assert(
    /RAISE NOTICE '.*already applied -- skipping \(idempotent\)/.test(sql),
    "expected the guard to skip (not error) when already applied",
  );
});

Deno.test("backfill inserts exactly 43 rows across exactly 21 canonical topics", async () => {
  const sql = await readMigration();
  const rowMatches = sql.match(
    /\('019f[0-9a-f-]+', '[a-z_.]+', '019f[0-9a-f-]+', '[^']*', DATE '\d{4}-\d{2}-\d{2}', (?:NULL|DATE '\d{4}-\d{2}-\d{2}'), '(?:municode|encode_zoning)',/g,
  ) ?? [];
  assert(
    rowMatches.length === 43,
    `expected exactly 43 crosswalk row VALUES tuples, found ${rowMatches.length}`,
  );

  const topicIds = new Set(
    rowMatches.map((r) => r.split("', '")[1]),
  );
  assert(
    topicIds.size === 21,
    `expected exactly 21 distinct canonical_topic_id values, found ${topicIds.size}`,
  );

  const crosswalkIds = rowMatches.map((r) => r.match(/'(019f[0-9a-f-]+)'/)![1]);
  assert(
    new Set(crosswalkIds).size === crosswalkIds.length,
    "expected every crosswalk row id to be unique",
  );
});

Deno.test("every non-zoning topic is source_type='municode' and every zoning topic is source_type='encode_zoning'", async () => {
  const sql = await readMigration();
  const zoningBlock = sql.slice(sql.indexOf("-- zMOD zoning renumbering"));
  const zoningEncodeCount = (zoningBlock.match(/'encode_zoning'/g) ?? []).length;
  assert(
    zoningEncodeCount === 4,
    `expected exactly 4 'encode_zoning' source_type values in the zoning block (2 topics x 2 rows), found ${zoningEncodeCount}`,
  );
  const preZoningBlock = sql.slice(0, sql.indexOf("-- zMOD zoning renumbering"));
  const preZoningEncodeCount = (preZoningBlock.match(/'encode_zoning'/g) ?? []).length;
  assert(
    preZoningEncodeCount === 1,
    `expected exactly 1 'encode_zoning' mention before the zoning block (the CHECK constraint declaration only, no row values), found ${preZoningEncodeCount}`,
  );
});

Deno.test("zoning.accessory_dwelling_unit's current-side row targets the verified 4102.7.B leaf row, not the coarser 4102.7 parent section some eval notes loosely cited", async () => {
  const sql = await readMigration();
  assert(
    sql.includes("'019f4c4c-7e79-7815-a2c0-a64f421fd20d', '4102.7.B'"),
    "expected the ADU current-side row to reference the specific 4102.7.B (Accessory Living Unit) leaf provision",
  );
  assert(
    !sql.includes("'019f4c4c-7368-74e9-9e28-946612b06d8b', '4102.7"),
    "must not use the coarser parent '4102.7 Accessory Uses' section as the ADU crosswalk target -- verified by direct content read to be a different (parent/heading) row, not the substantive ADU standards text",
  );
});

Deno.test("zoning.home_occupation's current-side row targets the verified 4102.7.H row", async () => {
  const sql = await readMigration();
  assert(
    sql.includes("'019f4c4c-a1bf-7680-8c84-b79a23bdbfb1', '4102.7.H'"),
    "expected the Home Occupation current-side row to reference 4102.7.H (Home-Based Business)",
  );
});

Deno.test("both zoning topics use the verified real 2023-05-10 supersession/effective date, not a 2021 date or the row's own ingestion-time placeholder", async () => {
  const sql = await readMigration();
  const zoningBlock = sql.slice(sql.indexOf("-- zMOD zoning renumbering"));
  assert(
    (zoningBlock.match(/DATE '2023-05-10'/g) ?? []).length === 4,
    "expected 2023-05-10 used 4 times in the zoning block: 1 old-row superseded_date + 1 new-row effective_date, per topic (x2 topics)",
  );
  assert(
    !/DATE '2021-12-02'|DATE '2021-07-01'/.test(sql),
    "no DATE literal should use the unverified/wrong 2021 zMOD dates",
  );
});

Deno.test("alcohol.public_open_container_possession correctly groups the consolidated old Sec. 5-1-27 under the same topic as Sec. 5-1-25", async () => {
  const sql = await readMigration();
  const topicRows = sql.match(
    /'019f8549-[0-9a-f-]+', 'alcohol\.public_open_container_possession', '019f[0-9a-f-]+', 'Sec\. 5-1-2[57]'/g,
  ) ?? [];
  assert(
    topicRows.length === 3,
    `expected 3 rows under alcohol.public_open_container_possession (old 5-1-25, old 5-1-27, current 5-1-25), found ${topicRows.length}`,
  );
  assert(
    sql.includes("'019f6923-cc31-7f6b-85d1-c7d12eee4dbe', 'Sec. 5-1-27'"),
    "expected the absorbed old Sec. 5-1-27 row to be present and grouped into this topic",
  );
});

Deno.test("deliberately-excluded repealed/coincidental-reuse sections are documented, not silently omitted", async () => {
  const sql = await readMigration();
  for (
    const excluded of [
      "Chapter 28",
      "Chapter 29",
      "Section 23-1-5",
      "Section 23-1-6",
      "1989-repealed Section 12-1-4",
    ]
  ) {
    assert(
      sql.includes(excluded),
      `expected the exclusion comment to name ${excluded} as a deliberately-excluded non-continuation`,
    );
  }
  // None of the excluded rows' ids should appear as an actual inserted row value.
  assert(
    !sql.includes("019f6927-4e0b-79de-8b43-2d437fadfaa8'"), // Section 23-1-5 old row
    "the excluded Section 23-1-5 (citation-reuse, not a real continuation) row id must not appear in an inserted VALUES tuple",
  );
  assert(
    !sql.includes("019f6927-4f67-7475-a6e6-d13b12e47f51'"), // Section 23-1-6 old row
    "the excluded Section 23-1-6 (repealed, no successor) row id must not appear in an inserted VALUES tuple",
  );
  assert(
    !sql.includes("019f692e-d420-773e-a39c-8479fb603dad'"), // 1989-repealed Sec 12-1-4 variant
    "the excluded 1989-repealed Section 12-1-4 variant row id must not appear in an inserted VALUES tuple",
  );
});

Deno.test("no data field cites a fabricated ordinance number, and the honest ~86-candidate/19-used disclosure is present", async () => {
  const sql = await readMigration();
  assert(
    !sql.includes("Ord. 19-19-112"),
    "must not cite the previously-fabricated 'Ord. 19-19-112' ordinance number",
  );
  assert(
    sql.includes("~86 municode_node_id groups") && sql.includes("follow-up"),
    "expected the migration to honestly disclose that only a curated subset of the ~86 content-differing candidates was backfilled, not silently imply full coverage",
  );
});
