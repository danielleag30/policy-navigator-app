/**
 * Tests for task 2-19: chunk supersession on document re-ingestion.
 *
 * AC-1: Supersession UPDATE is called before finalization in both PDF and Municode branches.
 * AC-2: All 10 stored functions (bm25_* × 5 + match_* × 5) include documents JOIN + status filter.
 * AC-3: No chunk rows deleted — supersession is a status flag only.
 * AC-4: Migration SQL excludes superseded rows from all query functions.
 * AC-5: 'superseded' is a valid CHECK value in documents.status.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertStringIncludes(actual: string, expected: string, msg?: string): void {
  if (!actual.includes(expected)) {
    throw new Error(msg ?? `Expected string to include: ${JSON.stringify(expected)}`);
  }
}

function assertNotEquals<T>(actual: T, unexpected: T, msg?: string): void {
  if (actual === unexpected) {
    throw new Error(msg ?? `Expected value to not equal: ${JSON.stringify(unexpected)}`);
  }
}

// ---------------------------------------------------------------------------
// AC-2 / AC-4: Migration SQL contains correct supersession filter
// ---------------------------------------------------------------------------

Deno.test("AC-2: migration defines all 10 stored functions with supersession filter", async () => {
  const sql = await Deno.readTextFile(
    "./supabase/migrations/20260623000200_supersession_query_filter.sql",
  );

  assertStringIncludes(sql, "d.status != 'superseded'", "filter must appear in migration");

  const tables = [
    "ordinance_provisions",
    "vote_tallies",
    "policy_decisions",
    "budget_indicators",
    "narrative_chunks",
  ];
  for (const t of tables) {
    assertStringIncludes(sql, `bm25_${t}`, `bm25_${t} must be redefined`);
    assertStringIncludes(sql, `match_${t}`, `match_${t} must be redefined`);
  }
});

Deno.test("AC-4: every function definition includes the documents JOIN", async () => {
  const sql = await Deno.readTextFile(
    "./supabase/migrations/20260623000200_supersession_query_filter.sql",
  );

  // Each CREATE OR REPLACE block must JOIN documents
  const functionBlocks = sql.split("CREATE OR REPLACE FUNCTION").slice(1);
  assert(functionBlocks.length === 10, `expected 10 function definitions, got ${functionBlocks.length}`);

  for (let i = 0; i < functionBlocks.length; i++) {
    const block = functionBlocks[i];
    assertStringIncludes(block, "JOIN documents d ON d.id =", `function block ${i + 1} missing documents JOIN`);
    assertStringIncludes(block, "d.status != 'superseded'", `function block ${i + 1} missing status filter`);
  }
});

Deno.test("AC-4: migration uses CREATE OR REPLACE (idempotent)", async () => {
  const sql = await Deno.readTextFile(
    "./supabase/migrations/20260623000200_supersession_query_filter.sql",
  );
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION");
  // Should NOT use DROP FUNCTION
  assert(!sql.includes("DROP FUNCTION"), "migration must not use DROP FUNCTION");
});

// ---------------------------------------------------------------------------
// AC-1: Supersession precedes finalization in both branches
// ---------------------------------------------------------------------------

Deno.test("AC-1: PDF branch — supersession error guard appears before finalization error guard", async () => {
  const src = await Deno.readTextFile(
    "./supabase/functions/ingest-orchestrator/index.ts",
  );

  // Isolate the PDF branch section (between the PDF branch comment and the Municode branch comment)
  const pdfStart = src.indexOf("── PDF branch");
  const municodeStart = src.indexOf("── Municode branch");
  assert(pdfStart !== -1, "PDF branch section not found");
  assert(municodeStart !== -1, "Municode branch section not found");
  assert(pdfStart < municodeStart, "PDF branch must precede Municode branch");

  const pdfSection = src.slice(pdfStart, municodeStart);

  assertStringIncludes(pdfSection, "Supersession failed", "PDF branch must contain supersession error guard");
  assertStringIncludes(pdfSection, "Document finalization failed", "PDF branch must contain finalization error guard");

  const supersedePos = pdfSection.indexOf("Supersession failed");
  const finalPos = pdfSection.indexOf("Document finalization failed");
  assert(supersedePos < finalPos, "supersession must precede finalization in PDF branch");
});

Deno.test("AC-1: Municode branch — supersession error guard appears before finalization error guard", async () => {
  const src = await Deno.readTextFile(
    "./supabase/functions/ingest-orchestrator/index.ts",
  );

  const municodeStart = src.indexOf("── Municode branch");
  assert(municodeStart !== -1, "Municode branch section not found");

  const municodeSection = src.slice(municodeStart);

  assertStringIncludes(municodeSection, "Supersession failed", "Municode branch must contain supersession error guard");
  assertStringIncludes(municodeSection, "Document finalization failed", "Municode branch must contain finalization error guard");

  const supersedePos = municodeSection.indexOf("Supersession failed");
  const finalPos = municodeSection.indexOf("Document finalization failed");
  assert(supersedePos < finalPos, "supersession must precede finalization in Municode branch");
});

Deno.test("AC-1: supersession appears in both PDF and Municode branches (two occurrences)", async () => {
  const src = await Deno.readTextFile(
    "./supabase/functions/ingest-orchestrator/index.ts",
  );

  const matches = src.match(/Supersession failed/g);
  assert(
    matches !== null && matches.length >= 2,
    `expected supersession error guard in both branches, found ${matches?.length ?? 0}`,
  );
});

Deno.test("AC-1: supersession uses status:'superseded' UPDATE in both branches", async () => {
  const src = await Deno.readTextFile(
    "./supabase/functions/ingest-orchestrator/index.ts",
  );

  const statusMatches = src.match(/status:\s*["']superseded["']/g);
  assert(
    statusMatches !== null && statusMatches.length >= 2,
    `expected status:'superseded' update in both branches, found ${statusMatches?.length ?? 0}`,
  );
});

// ---------------------------------------------------------------------------
// AC-3: No rows deleted during supersession — status flag only
// ---------------------------------------------------------------------------

Deno.test("AC-3: orchestrator does not call .delete() on documents for supersession", async () => {
  const src = await Deno.readTextFile(
    "./supabase/functions/ingest-orchestrator/index.ts",
  );

  // Extract both supersession blocks and verify no .delete() is called within them
  const pdfStart = src.indexOf("── PDF branch");
  const municodeStart = src.indexOf("── Municode branch");
  const pdfSection = src.slice(pdfStart, municodeStart);
  const municodeSection = src.slice(municodeStart);

  const pdfSupersedeBlock = pdfSection.slice(
    pdfSection.indexOf("Task 2-19"),
    pdfSection.indexOf("Task 2-6: finalize"),
  );
  const muniSupersedeBlock = municodeSection.slice(
    municodeSection.indexOf("Task 2-19"),
    municodeSection.indexOf("Task 2-6: finalize"),
  );

  assert(
    !pdfSupersedeBlock.includes(".delete()"),
    "PDF supersession block must not call .delete()",
  );
  assert(
    !muniSupersedeBlock.includes(".delete()"),
    "Municode supersession block must not call .delete()",
  );
});

Deno.test("AC-3: supersession migration contains no DELETE statements", async () => {
  const sql = await Deno.readTextFile(
    "./supabase/migrations/20260623000200_supersession_query_filter.sql",
  );
  assert(
    !sql.toUpperCase().includes("\nDELETE "),
    "supersession migration must not contain DELETE statements",
  );
});

// ---------------------------------------------------------------------------
// AC-5: 'superseded' is a valid CHECK value in documents.status
// ---------------------------------------------------------------------------

Deno.test("AC-5: documents migration includes 'superseded' in status CHECK constraint", async () => {
  const sql = await Deno.readTextFile("./supabase/migrations/001_documents.sql");
  assertStringIncludes(
    sql,
    "'superseded'",
    "documents.status CHECK constraint must include 'superseded'",
  );
});
