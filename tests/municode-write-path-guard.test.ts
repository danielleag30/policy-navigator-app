function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const MUNICODE_SRC = new URL(
  "../supabase/functions/ingest-orchestrator/municode.ts",
  import.meta.url,
).pathname;

async function importMunicodeModule() {
  Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  return await import("../supabase/functions/ingest-orchestrator/municode.ts");
}

Deno.test("shipping Municode date guard rejects older and unknown supersession dates", async () => {
  const { effectiveDateCanSupersede } = await importMunicodeModule();

  assert(
    effectiveDateCanSupersede("2026-04-28", "2026-04-28"),
    "same effective_date may preserve the incumbent/current transition semantics",
  );
  assert(
    effectiveDateCanSupersede("2026-05-01", "2026-04-28"),
    "newer effective_date should be allowed to supersede",
  );
  assert(
    !effectiveDateCanSupersede("2026-04-27", "2026-04-28"),
    "older effective_date must not supersede a newer current row",
  );
  assert(
    !effectiveDateCanSupersede(null, "2026-04-28"),
    "unknown incoming effective_date must not supersede",
  );
  assert(
    !effectiveDateCanSupersede("2026-04-28", null),
    "unknown incumbent effective_date must not be blindly superseded",
  );
});

Deno.test("shipping Municode upsert checks node/content_hash before current-row supersession", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const upsertStart = src.indexOf("async function upsertProvision(");
  assert(
    upsertStart !== -1,
    "upsertProvision must exist in the shipping module",
  );
  const currentLookup = src.indexOf('.eq("is_current", true)', upsertStart);
  const hashLookup = src.indexOf('.eq("content_hash", newHash)', upsertStart);
  const insert = src.indexOf(
    '.from("ordinance_provisions").insert({',
    upsertStart,
  );

  assert(
    hashLookup !== -1,
    "upsertProvision must look up existing content_hash rows",
  );
  assert(
    currentLookup !== -1,
    "upsertProvision must still check the incumbent current row",
  );
  assert(insert !== -1, "upsertProvision insert path must exist");
  assert(
    hashLookup < currentLookup && hashLookup < insert,
    "content-hash dedup must run before supersession and before inserting a new row",
  );
  assert(
    src.includes("!effectiveDateCanSupersede("),
    "upsertProvision must gate supersession through effectiveDateCanSupersede",
  );
});

Deno.test("shipping historical Municode insert also dedups by node/content_hash", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const historicalStart = src.indexOf(
    "async function upsertHistoricalProvision(",
  );
  assert(
    historicalStart !== -1,
    "upsertHistoricalProvision must exist in the shipping module",
  );
  const hashLookup = src.indexOf(
    '.eq("content_hash", newHash)',
    historicalStart,
  );
  const dateLookup = src.indexOf(
    '.eq("effective_date", ctx.effectiveDate)',
    historicalStart,
  );
  const insert = src.indexOf(
    '.from("ordinance_provisions").insert({',
    historicalStart,
  );

  assert(
    hashLookup !== -1 && dateLookup !== -1 && insert !== -1,
    "historical insert must have hash lookup, date lookup, and insert paths",
  );
  assert(
    hashLookup < dateLookup && hashLookup < insert,
    "historical content-hash dedup must run before effective_date lookup and insert",
  );
});
