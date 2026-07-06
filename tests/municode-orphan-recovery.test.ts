/**
 * Tests for Municode orphan-document recovery (fix/municode-orphan-recovery).
 *
 * Bug: findResumableDocument() only recognizes an in-progress walk via a
 * non-null municode_resume_state. When a walk fully drains (resume_state
 * cleared) but the invocation crashes before index.ts finishes
 * embedOrdinanceProvisions()/finalization, documents.status never flips to
 * 'current'. Every retry then fell through to a fresh INSERT and failed
 * forever on the documents_url_key unique constraint.
 *
 * classifyOrphanRecovery() (_municode-helpers.ts) is pure and unit tested
 * directly here. Its wiring into municode.ts's fresh-insert branch is
 * verified via static source inspection, matching the existing convention in
 * tests/preflight.test.ts (no live Supabase instance is available in CI).
 */

import { classifyOrphanRecovery } from "../supabase/functions/ingest-orchestrator/_municode-helpers.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// classifyOrphanRecovery (pure logic)
// ---------------------------------------------------------------------------

Deno.test("classifyOrphanRecovery: no document at URL → insert-fresh", () => {
  assertEquals(classifyOrphanRecovery(null, 0), "insert-fresh");
  assertEquals(classifyOrphanRecovery(null, 2722), "insert-fresh");
});

Deno.test("classifyOrphanRecovery: existing document already 'current' → insert-fresh (out of scope for this recovery path)", () => {
  const orphan = { status: "current", municode_resume_state: null };
  assertEquals(classifyOrphanRecovery(orphan, 2722), "insert-fresh");
});

Deno.test("classifyOrphanRecovery: existing document still holds a resume_state → insert-fresh (findResumableDocument's territory)", () => {
  const orphan = {
    status: "unknown",
    municode_resume_state: { jobId: "1", effectiveDate: "2026-01-01", queue: [] },
  };
  assertEquals(classifyOrphanRecovery(orphan, 500), "insert-fresh");
});

Deno.test(
  "classifyOrphanRecovery: not-current + null resume_state + provisions already written → finalize-only (THE BUG's exact scenario)",
  () => {
    const orphan = { status: "unknown", municode_resume_state: null };
    assertEquals(classifyOrphanRecovery(orphan, 2722), "finalize-only");
    assertEquals(classifyOrphanRecovery(orphan, 1), "finalize-only");
  },
);

Deno.test(
  "classifyOrphanRecovery: not-current + null resume_state + zero provisions → rewalk-from-root",
  () => {
    const orphan = { status: "unknown", municode_resume_state: null };
    assertEquals(classifyOrphanRecovery(orphan, 0), "rewalk-from-root");
  },
);

// ---------------------------------------------------------------------------
// Static source-inspection: wiring inside municode.ts
// ---------------------------------------------------------------------------

const MUNICODE_SRC = new URL(
  "../supabase/functions/ingest-orchestrator/municode.ts",
  import.meta.url,
).pathname;

function extractBetween(src: string, startMarker: string, endMarker: string): string {
  const startIdx = src.indexOf(startMarker);
  assert(startIdx !== -1, `Start marker not found: "${startMarker}"`);
  const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  assert(endIdx !== -1, `End marker not found after start: "${endMarker}"`);
  return src.slice(startIdx, endIdx);
}

Deno.test("wiring: municode.ts imports classifyOrphanRecovery from _municode-helpers.ts", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  assert(
    src.includes('import { classifyOrphanRecovery } from "./_municode-helpers.ts"'),
    "municode.ts must import classifyOrphanRecovery",
  );
});

Deno.test("wiring: orphan lookup by URL happens before the fresh document insert", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const orphanLookupIdx = src.indexOf('.eq("url", canonicalUrl)');
  const insertIdx = src.indexOf('db.from("documents").insert({');
  assert(orphanLookupIdx !== -1, "orphan lookup by canonicalUrl not found");
  assert(insertIdx !== -1, "fresh document insert not found");
  assert(
    orphanLookupIdx < insertIdx,
    "orphan lookup must run before the fresh document insert to avoid the documents_url_key failure",
  );
});

Deno.test("wiring: finalize-only branch returns complete:true without reaching the insert", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const branch = extractBetween(
    src,
    'if (action === "finalize-only") {',
    'else if (action === "rewalk-from-root") {',
  );
  assert(branch.includes("complete: true"), "finalize-only must return complete: true");
  assert(branch.includes("skipped: false"), "finalize-only must return skipped: false");
  assert(
    !branch.includes('db.from("documents").insert'),
    "finalize-only must not insert a new document row",
  );
  assert(
    branch.includes("ordinance_provisions"),
    "finalize-only must read back existing ordinance_provisions node ids",
  );
});

Deno.test("wiring: rewalk-from-root branch reuses the orphan id and does not insert a duplicate row", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const branch = extractBetween(
    src,
    'else if (action === "rewalk-from-root") {',
    "} else {\n      // 4. Create Document shell row",
  );
  assert(
    branch.includes("documentId = orphan!.id as string"),
    "rewalk-from-root must reuse the existing orphan document id",
  );
  assert(
    !branch.includes('db.from("documents").insert'),
    "rewalk-from-root must not insert a new document row (would hit documents_url_key again)",
  );
});

Deno.test("wiring: only the insert-fresh (else) branch performs the documents insert", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const elseBranch = extractBetween(
    src,
    "} else {\n      // 4. Create Document shell row",
    "\n  }\n\n  // 5. Iteratively walk all nodes",
  );
  assert(
    elseBranch.includes('db.from("documents").insert({'),
    "the insert-fresh branch must still perform the original insert for genuinely new documents",
  );
});

// ---------------------------------------------------------------------------
// Static source-inspection: orphan-recovery claim (concurrency race closure)
//
// Cross-review finding: two concurrent invocations could both read the same
// orphan snapshot and both proceed to finalize-only or both re-walk from
// root — the same class of race PR #75 closed for the resume-state lease via
// an atomic UPDATE ... WHERE ... RETURNING claim. These tests verify the same
// pattern was applied here, mirroring findResumableDocument()'s claim.
// ---------------------------------------------------------------------------

Deno.test("wiring: orphan-recovery claim runs for both finalize-only and rewalk-from-root, before either branch", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const claimGuardIdx = src.indexOf(
    'if (action === "finalize-only" || action === "rewalk-from-root") {',
  );
  const finalizeBranchIdx = src.indexOf('if (action === "finalize-only") {');
  assert(claimGuardIdx !== -1, "combined claim guard for both recovery actions not found");
  assert(finalizeBranchIdx !== -1, "finalize-only branch not found");
  assert(
    claimGuardIdx < finalizeBranchIdx,
    "the claim must be attempted before the finalize-only/rewalk-from-root branches execute",
  );
});

Deno.test("wiring: orphan-recovery claim atomically updates resume_claim_expires_at guarded by lease + resume_state", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const claimBlock = extractBetween(
    src,
    'if (action === "finalize-only" || action === "rewalk-from-root") {',
    'if (action === "finalize-only") {',
  );
  assert(
    claimBlock.includes(".update({ resume_claim_expires_at: leaseExpiresAt })"),
    "claim must be an UPDATE against resume_claim_expires_at, not a plain read",
  );
  assert(
    claimBlock.includes('.is("municode_resume_state", null)'),
    "claim WHERE guard must re-check the row hasn't entered an active resume-state walk",
  );
  assert(
    claimBlock.includes(
      "resume_claim_expires_at.is.null,resume_claim_expires_at.lt.",
    ),
    "claim WHERE guard must re-check lease eligibility (null or expired) at UPDATE time, same as findResumableDocument()",
  );
});

Deno.test("wiring: a lost orphan-recovery claim requeues (complete:false) without finalizing or re-walking", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const claimBlock = extractBetween(
    src,
    'if (action === "finalize-only" || action === "rewalk-from-root") {',
    'if (action === "finalize-only") {',
  );
  const lossBranch = extractBetween(claimBlock, "if (!claimedOrphan) {", "\n      }\n    }");
  assert(
    lossBranch.includes("complete: false"),
    "losing the claim must report complete: false (requeue), not proceed",
  );
  assert(
    !lossBranch.includes("ordinance_provisions") &&
      !lossBranch.includes('db.from("documents").insert'),
    "losing the claim must not read back provisions or insert — no work this invocation",
  );
});
