// Guards the removal of the orphan `document_chunks` embedding from the
// ingest-orchestrator PDF branch.
//
// Why a source-text guard rather than an executable unit test: the PDF-branch
// embedders (embedDocumentChunks/embedNarrativeChunks/...) are module-private
// helpers inside ingest-orchestrator/index.ts, and that module runs
// `Deno.serve(...)` at top-level import — it cannot be imported to exercise a
// single helper in isolation. Reading the REAL shipping index.ts (not a
// parallel re-implementation) is the same approach the repo already uses in
// municode-write-path-guard.test.ts, and it exercises the exact file that
// deploys.
//
// Background: `document_chunks` embeddings were read by no retrieval path — no
// query-pipeline TS file and no DB function reference the table — and its text
// is ~99.75% duplicated into the retrievable `narrative_chunks`, which is still
// embedded. Embedding document_chunks therefore embedded every PDF's text a
// second time on the HF embedding Space for zero consumer. This test fails if
// that orphan embed is reintroduced, or if the retrievable narrative embed or
// the (intentionally retained) raw-chunk staging insert is removed by accident.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const INDEX_SRC = new URL(
  "../supabase/functions/ingest-orchestrator/index.ts",
  import.meta.url,
).pathname;

Deno.test("ingest-orchestrator PDF branch does not embed the orphan document_chunks table", async () => {
  const src = await Deno.readTextFile(INDEX_SRC);

  // 1. The orphan embed — both the embedDocumentChunks() call in the PDF branch
  //    and the now-dead helper it fed — must be gone entirely.
  assert(
    !src.includes("embedDocumentChunks"),
    "embedDocumentChunks (call and/or definition) is still present — the orphan document_chunks embed was reintroduced",
  );

  // 2. Nothing may write an embedding back into document_chunks by any name.
  assert(
    !/\.from\(\s*["']document_chunks["']\s*\)[\s\S]{0,80}\.update\(/.test(src),
    "an embedding write-back to document_chunks is present — document_chunks must not be embedded",
  );

  // 3. The retrievable narrative_chunks embed MUST remain (guards against
  //    over-deletion of the real consumer path).
  assert(
    src.includes("embedNarrativeChunks("),
    "embedNarrativeChunks call is missing — the retrievable narrative embedding path was removed by mistake",
  );

  // 4. The raw-chunk staging insert into document_chunks is intentionally
  //    retained by this change (removing it alters ingestion data flow and is a
  //    separately-reviewed follow-up). Its absence here would mean the insert
  //    was dropped without that review.
  assert(
    src.includes('db.from("document_chunks").insert('),
    "the document_chunks staging insert was removed — that is out of scope for this change and must be reviewed separately",
  );
});
