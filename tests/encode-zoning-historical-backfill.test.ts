/**
 * Static-source-inspection tests for the targeted, one-time EnCode zoning
 * historical backfill migration (supabase/migrations/
 * 20260717032755_encode_zoning_historical_backfill.sql) and its two follow-up
 * corrections (supabase/migrations/
 * 20260717070000_fix_encode_zoning_historical_superseded_date.sql and
 * 20260717080000_fix_encode_zoning_document_superseded_by_metadata.sql).
 * Matches this repo's existing convention for data/content correctness (see
 * tests/encode-ingestion.test.ts's file header) since no live Supabase
 * instance is available in CI -- all three migrations were already applied
 * directly to the hosted project and independently verified there (real
 * content, embeddings populated by the existing historical-embedding retry
 * backlog, superseded_date corrected to 2023-05-10, and the parent document's
 * raw_api_response.superseded_by corrected to match); these tests guard the
 * committed SQL against silent regressions.
 */

const MIGRATION_PATH = "supabase/migrations/20260717032755_encode_zoning_historical_backfill.sql";
const FIX_MIGRATION_PATH =
  "supabase/migrations/20260717070000_fix_encode_zoning_historical_superseded_date.sql";
const FIX_METADATA_MIGRATION_PATH =
  "supabase/migrations/20260717080000_fix_encode_zoning_document_superseded_by_metadata.sql";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readMigration(): Promise<string> {
  return await Deno.readTextFile(MIGRATION_PATH);
}

async function readFixMigration(): Promise<string> {
  return await Deno.readTextFile(FIX_MIGRATION_PATH);
}

async function readFixMetadataMigration(): Promise<string> {
  return await Deno.readTextFile(FIX_METADATA_MIGRATION_PATH);
}

Deno.test("migration is idempotent: guards on the reprint URL before inserting", async () => {
  const sql = await readMigration();
  assert(
    /IF EXISTS \(SELECT 1 FROM public\.documents WHERE url = reprint_url\) THEN/.test(
      sql,
    ),
    "expected an idempotency guard checking for the reprint document by URL before inserting",
  );
  assert(
    /RETURN;/.test(sql),
    "expected the guard to RETURN early when the document already exists",
  );
});

Deno.test("historical document row uses an allowed doc_type/status and real source attribution", async () => {
  const sql = await readMigration();
  assert(
    /'encode_zoning',\s*\n\s*'superseded',/.test(sql),
    "expected doc_type='encode_zoning' (an allowed documents_doc_type_check value) and status='superseded'",
  );
  assert(
    sql.includes(
      "https://online.encodeplus.com/regs/fairfaxcounty-va/doclibrary.aspx?id=922528cd-6de4-4112-8678-79e8ed26a092",
    ),
    "expected the real EnCode Archives 2021 Reprint doclibrary URL",
  );
  assert(
    sql.includes("'historical_backfill', true"),
    "expected raw_api_response to mark this as a historical_backfill row, matching the Municode historical-backfill convention",
  );
});

Deno.test("both historical provisions are correctly flagged is_current=false with real effective/superseded dates", async () => {
  const sql = await readMigration();
  // 2023-05-10 is the Chapter 112.2 valid-readoption effective date, not the
  // 2021 zMOD adoption date -- that 2021 adoption was later declared void by
  // the Virginia Supreme Court (FOIA violation), so the pre-zMOD text in this
  // migration was only permanently superseded once the readoption took
  // effect. See the migration file's header comment for the full history.
  const falseCount = (sql.match(/false,\s*\n\s*DATE '2023-05-10',/g) ?? [])
    .length;
  assert(
    falseCount === 2,
    `expected exactly 2 rows with is_current=false and superseded_date='2023-05-10' (Chapter 112.2 valid-readoption effective date), found ${falseCount}`,
  );
  assert(
    (sql.match(/DATE '2021-06-30'/g) ?? []).length >= 2,
    "expected both provisions to carry the real 2021-06-30 reprint date as effective_date",
  );
  assert(
    sql.includes("'encode:historical:8-918'") &&
      sql.includes("'encode:historical:10-300'"),
    "expected the two distinct historical node ids (no current EnCode secid to attach to across the zMOD citation-numbering discontinuity)",
  );
});

Deno.test("both provisions are tagged source_type='encode_zoning', matching the existing current EnCode rows' source_type", async () => {
  const sql = await readMigration();
  const sourceTypeCount = (sql.match(/'encode_zoning'/g) ?? []).length;
  // 1 in the header comment + 1 doc_type + 1 per ordinance_provisions source_type (2) = 4.
  assert(
    sourceTypeCount === 4,
    `expected 'encode_zoning' on doc_type and both provisions' source_type (plus 1 header comment mention), found ${sourceTypeCount}`,
  );
});

Deno.test("ADU historical content reflects the real pre-zMOD rule (35% cap, BZA special permit, elderly/disabled occupancy) and not the current rule", async () => {
  const sql = await readMigration();
  assert(sql.includes("thirty-five (35)"), "expected the real pre-zMOD 35% gross-floor-area cap");
  assert(
    sql.includes("BZA may approve a special permit"),
    "expected the real pre-zMOD BZA special-permit requirement",
  );
  assert(
    sql.includes("fifty-five (55) years of age"),
    "expected the real pre-zMOD elderly-occupant (55+) qualification",
  );
  assert(
    !sql.includes("800 square feet of gross floor area or 40%"),
    "the historical ADU text must not contain the current (post-zMOD) 800 sq ft / 40% standard",
  );
});

Deno.test("Home Occupations historical content reflects the real pre-zMOD rule ($50 filing fee, named-trade list) and not the current rule", async () => {
  const sql = await readMigration();
  assert(
    sql.includes("filing fee of fifty dollars ($50)"),
    "expected the real pre-zMOD $50 home occupation filing fee",
  );
  assert(
    sql.includes("Artists and sculptors") && sql.includes("Horseback riding lessons"),
    "expected the real pre-zMOD named-trade permitted-use list",
  );
  assert(
    !sql.includes("400 square feet"),
    "the historical Home Occupations text must not contain the current (post-zMOD) 400 sq ft Home-Based Business cap",
  );
});

Deno.test("no DATE literal in the migration uses the wrong 2021 zMOD dates (prose mentioning 2021-07-01 as history is fine)", async () => {
  const sql = await readMigration();
  assert(
    !/DATE '2021-12-02'|DATE '2021-07-01'/.test(sql),
    "no DATE literal should use the unverified/wrong 2021-12-02 or 2021-07-01 zMOD dates -- the verified supersession date is 2023-05-10 (Chapter 112.2's valid readoption, after the original 2021 adoption was declared void)",
  );
  assert(
    !sql.includes("Ord. 19-19-112"),
    "the migration must not cite the unverified/fabricated 'Ord. 19-19-112' ordinance number",
  );
});

Deno.test("the correction migration is guarded by preconditions and targets exactly the 2 known rows", async () => {
  const sql = await readFixMigration();
  assert(
    sql.includes("superseded_date = DATE '2021-12-02'") &&
      sql.includes("SET superseded_date = DATE '2023-05-10'"),
    "expected the correction to move superseded_date from the wrong 2021-12-02 to the verified 2023-05-10",
  );
  assert(
    sql.includes("019f6e16-cac6-797e-a372-83f5e28a9cd5") &&
      sql.includes("019f6e16-cac8-77f7-8653-3c0f5eacfc9c"),
    "expected the correction to target exactly the 2 known historical row ids by id, not a broad WHERE clause",
  );
  assert(
    (sql.match(/RAISE NOTICE '.*skipping \(idempotent/g) ?? []).length === 2,
    "expected a precondition-guarded, idempotent skip path for both rows (safe to re-run)",
  );
  assert(
    sql.includes("Post-correction ADU row did not verify") &&
      sql.includes("Post-correction Home Occupations row did not verify"),
    "expected post-condition verification that the correction actually landed before considering the migration successful",
  );
});

Deno.test("the document-metadata correction migration fixes superseded_by on exactly the known document, guarded by preconditions", async () => {
  const sql = await readFixMetadataMigration();
  assert(
    sql.includes("019f6e16-cac3-754d-9adb-efce9391f6e8"),
    "expected the correction to target the known parent document id",
  );
  assert(
    sql.includes(
      "old_value text := 'zMOD comprehensive rewrite, Ord. 19-19-112, effective 2021-12-02'",
    ),
    "expected the precondition to require the exact original wrong superseded_by string before touching anything",
  );
  assert(
    sql.includes("Chapter 112.2 valid readoption, effective 2023-05-10") &&
      sql.includes(
        "Berry v. Board of Supervisors of Fairfax County, 884 S.E.2d 515 (Va. 2023)",
      ),
    "expected the corrected superseded_by value to cite the real, verified case (Berry v. Board of Supervisors, 884 S.E.2d 515 (Va. 2023)) and the 2023-05-10 date",
  );
  const newValueMatch = sql.match(/new_value text := '([^']*)'/);
  assert(
    newValueMatch !== null,
    "expected a new_value text declaration to inspect",
  );
  assert(
    !newValueMatch![1].includes("Ord. 19-19-112"),
    "the corrected (new_value) string must not repeat the fabricated 'Ord. 19-19-112' citation",
  );
  assert(
    sql.includes("jsonb_set(") && sql.includes("'{superseded_by}'"),
    "expected a targeted jsonb_set on the superseded_by key only, not a blind overwrite of raw_api_response",
  );
  assert(
    sql.includes("raw_api_response ->> 'historical_backfill' = 'true'") &&
      sql.includes("raw_api_response ->> 'reprint_date' = '2021-06-30'"),
    "expected the post-condition to verify the other raw_api_response keys were left untouched",
  );
});

Deno.test("no data field (as opposed to explanatory history comments) cites the fabricated 'Ord. 19-19-112' ordinance number as a real value", async () => {
  // FIX_MIGRATION_PATH's header comment and FIX_METADATA_MIGRATION_PATH's
  // old_value precondition both intentionally quote the original wrong
  // claim -- as history being corrected / the exact string a precondition
  // must match -- not an assertion of fact, so both are excluded here.
  // FIX_METADATA_MIGRATION_PATH's new_value is checked separately above.
  const paths = [
    MIGRATION_PATH,
    "eval/cases/temporal-correctness.json",
    "eval/cases/adversarial-near-miss.json",
  ];
  for (const path of paths) {
    const text = await Deno.readTextFile(path);
    assert(
      !text.includes("Ord. 19-19-112"),
      `${path} must not cite the unverified/fabricated 'Ord. 19-19-112' ordinance number`,
    );
  }
});
