/**
 * Static-source-inspection tests for the targeted, one-time EnCode zoning
 * historical backfill migration (supabase/migrations/
 * 20260717032755_encode_zoning_historical_backfill.sql). Matches this repo's
 * existing convention for data/content correctness (see
 * tests/encode-ingestion.test.ts's file header) since no live Supabase
 * instance is available in CI -- the migration was already applied directly
 * to the hosted project and independently verified there (real content,
 * embeddings populated by the existing historical-embedding retry backlog);
 * these tests guard the committed SQL against silent regressions.
 */

const MIGRATION_PATH = "supabase/migrations/20260717032755_encode_zoning_historical_backfill.sql";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readMigration(): Promise<string> {
  return await Deno.readTextFile(MIGRATION_PATH);
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
  const falseCount = (sql.match(/false,\s*\n\s*DATE '2021-12-02',/g) ?? [])
    .length;
  assert(
    falseCount === 2,
    `expected exactly 2 rows with is_current=false and superseded_date='2021-12-02' (zMOD effective date), found ${falseCount}`,
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
