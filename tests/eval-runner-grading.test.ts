/**
 * Tests for eval/runner.ts's answer-text grading tolerance (remediation Wave 4a).
 *
 * These tests import and exercise the REAL shipping grader from eval/runner.ts
 * (`evaluateCriterion`, `tolerantContains`) — NOT a re-implemented copy. This
 * repo has a documented history of tests-of-copies passing while shipping code
 * was broken (see the eval-grading-bug thread in the execution log); a copy
 * here would defeat the purpose. Mutating the matcher in runner.ts must break
 * these tests.
 *
 * Importing runner.ts is side-effect-free: all live-run machinery (CLI, env,
 * network, DB) is guarded behind `import.meta.main`.
 *
 * Scope guard (owner decision, non-negotiable): only the free-text
 * `answer_contains`/`answer_not_contains` checks are loosened. `cites_chunk`
 * stays an EXACT chunk_id string match — the exactness tests below lock that in.
 */

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateCriterion, normalizeAnswerText, tolerantContains } from "../eval/runner.ts";
import type { EvalCriterion } from "../eval/schema.ts";

// ---------------------------------------------------------------------------
// Load the REAL adversarial-001 case from eval/cases (regression fixture must
// be the real shipped case, not an invented one).
// ---------------------------------------------------------------------------

interface RawCase {
  id: string;
  chunk_ids: string[];
  criteria: EvalCriterion[];
}

const ADVERSARIAL_FILE = new URL(
  "../eval/cases/adversarial-near-miss.json",
  import.meta.url,
);

async function loadAdversarial001(): Promise<RawCase> {
  const raw = await Deno.readTextFile(ADVERSARIAL_FILE);
  const cases = JSON.parse(raw) as RawCase[];
  const c = cases.find((x) => x.id === "adversarial-001");
  assert(c, "adversarial-001 must exist in eval/cases/adversarial-near-miss.json");
  return c;
}

/**
 * Realistic reproduction of the pipeline answer that triggered the false-fail:
 * it cites the correct current Chapter 9.2 chunk and states the conditional
 * franchise-fee rule, but paraphrases the criterion's "allows" as "permits".
 * (Confirmed real case — execution log 2026-07-17, Fable audit finding.)
 */
const PARAPHRASED_ANSWER =
  "Chapter 9.1 (Communications) was repealed and replaced by Chapter 9.2 " +
  "(Cable Television), effective January 1, 2020. Under the current Section " +
  "9.2-7-1 (Payments by grantees), the franchise fee is conditional: if at any " +
  "time state law permits the imposition of a franchise fee on cable operators " +
  "in Virginia, the County may require a franchise fee of five percent of gross " +
  "revenues.";

// ---------------------------------------------------------------------------
// The headline regression: adversarial-001 must flip from false-fail to pass
// through the REAL grader.
// ---------------------------------------------------------------------------

Deno.test("adversarial-001: 'allows' paraphrased as 'permits' now passes the real answer_contains grader", async () => {
  const c = await loadAdversarial001();
  const containsCriterion = c.criteria.find(
    (x) => x.check.type === "answer_contains",
  );
  assert(containsCriterion, "adversarial-001 must have an answer_contains criterion");
  const substring = (containsCriterion.check as { substring: string }).substring;

  // Before: the old raw case-insensitive substring match FAILS on this answer
  // (this is exactly the false-fail the fix removes) — documents the delta.
  assertFalse(
    PARAPHRASED_ANSWER.toLowerCase().includes(substring.toLowerCase()),
    "sanity: the raw substring match should still fail on 'permits' — that is the bug being fixed",
  );

  // After: the real shipping grader passes it.
  const result = evaluateCriterion(containsCriterion, {
    answer: PARAPHRASED_ANSWER,
    citations: [{ chunk_id: c.chunk_ids[0] }],
  });
  assert(
    result.pass,
    `answer_contains should tolerantly pass; note: ${result.note ?? "(none)"}`,
  );
});

Deno.test("adversarial-001: all three criteria pass end-to-end on the paraphrased-but-correct answer", async () => {
  const c = await loadAdversarial001();
  const responseData = {
    answer: PARAPHRASED_ANSWER,
    citations: [{ chunk_id: c.chunk_ids[0] }],
  };
  const results = c.criteria.map((crit) => evaluateCriterion(crit, responseData));
  for (const r of results) {
    assert(r.pass, `criterion ${r.criterion_id} unexpectedly failed: ${r.note ?? ""}`);
  }
});

// ---------------------------------------------------------------------------
// HARD CONSTRAINT: cites_chunk stays EXACT. These lock the exactness in so a
// future "helpful" loosening of citation grading breaks the build.
// ---------------------------------------------------------------------------

Deno.test("cites_chunk stays EXACT — correct id passes, mutated ids fail", async () => {
  const c = await loadAdversarial001();
  const citesCriterion = c.criteria.find((x) => x.check.type === "cites_chunk");
  assert(citesCriterion, "adversarial-001 must have a cites_chunk criterion");
  const exactId = (citesCriterion.check as { chunk_id: string }).chunk_id;

  // Exact match passes.
  assert(
    evaluateCriterion(citesCriterion, { citations: [{ chunk_id: exactId }] }).pass,
    "exact chunk_id must pass",
  );

  // Off-by-one-character id fails (no fuzzy citation matching).
  const flipped = exactId.slice(0, -1) + (exactId.endsWith("7") ? "8" : "7");
  assertFalse(
    evaluateCriterion(citesCriterion, { citations: [{ chunk_id: flipped }] }).pass,
    "a chunk_id differing by one character must fail — citation grading is exact",
  );

  // Whitespace-padded id fails (no trimming/normalization on citations).
  assertFalse(
    evaluateCriterion(citesCriterion, { citations: [{ chunk_id: ` ${exactId} ` }] })
      .pass,
    "a whitespace-padded chunk_id must fail — citation grading is exact",
  );

  // Uppercased id fails (UUID match is case-sensitive/exact).
  assertFalse(
    evaluateCriterion(citesCriterion, {
      citations: [{ chunk_id: exactId.toUpperCase() }],
    }).pass,
    "an uppercased chunk_id must fail — citation grading is exact",
  );

  // No citations at all fails.
  assertFalse(
    evaluateCriterion(citesCriterion, { citations: [] }).pass,
    "empty citations must fail cites_chunk",
  );
});

// ---------------------------------------------------------------------------
// tolerantContains unit behavior (via the real exported function).
// ---------------------------------------------------------------------------

Deno.test("tolerantContains: synonym canonicalization (allow/permit/authorize) both directions", () => {
  assert(tolerantContains("state law permits the fee", "state law allows the fee"));
  assert(tolerantContains("state law allows the fee", "state law permits the fee"));
  assert(
    tolerantContains("the County may authorize a franchise fee", "may allow a franchise fee"),
  );
});

Deno.test("tolerantContains: normalizes case, whitespace, and punctuation", () => {
  assert(tolerantContains("Effective  January 1,   2020.", "effective january 1 2020"));
  assert(tolerantContains("Va. Code §§ 36-97", "va code 36 97"));
  assert(tolerantContains("...repealed by Ord. No. 08-00-28.", "08-00-28"));
});

Deno.test("tolerantContains: order-independent coverage fallback for minor reordering", () => {
  // All content tokens present but the substring's exact contiguous order is not.
  assert(
    tolerantContains(
      "The franchise fee is five percent of gross revenues.",
      "franchise fee of five percent",
    ),
  );
});

Deno.test("tolerantContains: does NOT match unrelated text (guards against always-true)", () => {
  assertFalse(
    tolerantContains(
      "Massage establishment regulations were repealed under Chapter 28.",
      "state law allows the imposition of a franchise fee",
    ),
  );
  assertFalse(tolerantContains("The dog licensing rules changed.", "800 square feet"));
  // A single overlapping stopword-free token is well under threshold.
  assertFalse(tolerantContains("franchise agreements exist", "annual franchise renewal fee cap"));
});

Deno.test("tolerantContains: empty answer never matches a non-empty substring", () => {
  assertFalse(tolerantContains("", "state law allows the imposition of a franchise fee"));
});

Deno.test("normalizeAnswerText: canonicalizes synonyms and strips punctuation", () => {
  assertEquals(normalizeAnswerText("Permits, allowed & AUTHORIZED!"), [
    "allow",
    "allow",
    "allow",
  ]);
  assertEquals(normalizeAnswerText("§ 5-1-25"), ["5", "1", "25"]);
});

// ---------------------------------------------------------------------------
// answer_not_contains inherits the same tolerance (harder to "not contain").
// ---------------------------------------------------------------------------

Deno.test("answer_not_contains: fails when the answer tolerantly contains the forbidden phrase", () => {
  const crit: EvalCriterion = {
    id: "t-not-contains",
    description: "must not assert that state law allows the imposition of a fee",
    check: {
      type: "answer_not_contains",
      substring: "state law allows the imposition of a fee",
    },
  };
  const answer = "Under current law, state law permits the imposition of a fee only conditionally.";
  // The raw substring match would MISS this ("permits" != "allows") and wrongly
  // let it pass; the tolerant check canonicalizes the synonym and catches it.
  assertFalse(
    answer.toLowerCase().includes("state law allows the imposition of a fee"),
    "sanity: raw substring would not catch the 'permits' paraphrase",
  );
  const r = evaluateCriterion(crit, { answer });
  assertFalse(r.pass, "tolerant answer_not_contains should catch the paraphrase");
});

Deno.test("answer_not_contains: passes when the phrase is genuinely absent", () => {
  const crit: EvalCriterion = {
    id: "t-not-contains-2",
    description: "must not contain unrelated phrasing",
    check: { type: "answer_not_contains", substring: "monthly report of outstanding bonds" },
  };
  const r = evaluateCriterion(crit, {
    answer: "Chapter 9.2 governs cable television franchise fees.",
  });
  assert(r.pass, "unrelated answer should pass answer_not_contains");
});
