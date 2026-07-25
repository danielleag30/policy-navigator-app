/**
 * Tests for the Temporal-Judge candidate-window widening (query-relevant span
 * selection). Every function under test is the REAL shipping implementation
 * imported from ./index.ts — no reimplementations. The judge can only select a
 * chunk whose decisive text it can SEE; the prior serializer showed each
 * candidate's first 600 chars only, so operative clauses deeper in a section were
 * invisible (temporal-005: gold ranks #2 in the vector arm yet the case refuses
 * because its "Class 2 misdemeanor" clause sits at char 1,028 of a 1,068-char
 * row, past the 600-char head).
 *
 * Run from the REPO ROOT (a function-subdir cwd picks up the wrong deno.json):
 *   deno test --allow-env --allow-read --allow-net --node-modules-dir=auto \
 *     supabase/functions/query-pipeline/judge_window_test.ts
 */

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role-key",
);

import type { EnrichedCandidate } from "./index.ts";

const { judgeQueryTerms, selectJudgeSpans, serializeChunk } = await import(
  "./index.ts"
);

// ── Dependency-free asserts (match rrf_test.ts / _ordinance-gate_test.ts style) ─
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// ── Faithful temporal-005-shaped fixture ─────────────────────────────────────
// A ~1,068-char section whose operative penalty clause sits near the end, past
// the old 600-char head. Measured live: temporal-005's "Class 2 misdemeanor"
// begins at char 1,028 of 1,068.
const DECISIVE =
  "Violation of this section shall constitute a Class 2 misdemeanor.";
const HEAD_FILLER =
  "It shall be unlawful for any person to keep, harbor, or maintain within the County any animal in a manner that creates a public nuisance or endangers the health, safety, or welfare of the residents thereof. The provisions of this section apply to all zoning districts and to both residential and commercial premises. Enforcement of this section is vested in the animal-control officer, who may issue notices of violation and may impound any animal maintained in contravention hereof. Any person aggrieved by an order issued under this section may appeal to the County Executive within ten days of the date of the order, and the County Executive shall render a decision within thirty days. Nothing in this section shall be construed to limit any other remedy available at law or in equity, nor to relieve any person of any duty imposed by any other provision of this Code or of applicable state law governing the keeping of animals within the Commonwealth and its political subdivisions and any incorporated town lying wholly or partly therein. ";
const TEMPORAL_005_TEXT = HEAD_FILLER + DECISIVE;
const TEMPORAL_005_QUERY =
  "What is the penalty for violating this section — is it a misdemeanor?";

// Sanity: the fixture really places the decisive clause past the old 600 head.
Deno.test("fixture places decisive clause past the old 600-char head", () => {
  const at = TEMPORAL_005_TEXT.indexOf("Class 2 misdemeanor");
  assert(at > 600, `decisive clause must sit past char 600, found at ${at}`);
  assert(
    TEMPORAL_005_TEXT.length <= 1500,
    `fixture must fit under budget to model temporal-005 (len ${TEMPORAL_005_TEXT.length})`,
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// MUTATION PROBE — proves the test is non-vacuous: the SAME assertion fails under
// the pre-fix behaviour (head-600) and passes under the shipping implementation.
// Emits literal RED / GREEN so the discrimination is visible in test output.
// ══════════════════════════════════════════════════════════════════════════════
Deno.test("MUTATION PROBE: head-600 hides the decisive clause; selectJudgeSpans surfaces it", () => {
  // The verbatim pre-fix serializer body (the mutant we are killing).
  const oldHead600 = (text: string) =>
    text.length > 600 ? text.slice(0, 600) + "…" : text;

  const mutant = oldHead600(TEMPORAL_005_TEXT);
  const shipping = selectJudgeSpans(TEMPORAL_005_QUERY, TEMPORAL_005_TEXT);

  const mutantSees = mutant.includes("Class 2 misdemeanor");
  const shippingSees = shipping.includes("Class 2 misdemeanor");

  console.log(
    `[mutation-probe] pre-fix head-600      -> ${
      mutantSees ? "GREEN" : "RED"
    } (decisive clause ${mutantSees ? "visible" : "NOT visible"})`,
  );
  console.log(
    `[mutation-probe] selectJudgeSpans (ship)-> ${
      shippingSees ? "GREEN" : "RED"
    } (decisive clause ${shippingSees ? "visible" : "NOT visible"})`,
  );

  // The probe only has teeth if the mutant genuinely fails where shipping passes.
  assert(
    !mutantSees,
    "MUTATION PROBE INERT: pre-fix head-600 already showed the clause — fixture is not discriminating",
  );
  assert(
    shippingSees,
    "REGRESSION: selectJudgeSpans failed to surface the decisive clause",
  );
});

// ── selectJudgeSpans: whole-chunk-fits path (the temporal-005 fix) ───────────
Deno.test("whole chunk under budget is returned verbatim (no loss)", () => {
  const out = selectJudgeSpans(TEMPORAL_005_QUERY, TEMPORAL_005_TEXT);
  assertEqual(
    out,
    TEMPORAL_005_TEXT,
    "sub-budget text must be returned verbatim",
  );
  assert(out.includes(DECISIVE), "decisive clause must be present");
});

// ── selectJudgeSpans: large row — query-relevant windowing surfaces deep text ─
Deno.test("large row: query-term window surfaces decisive text head-600 would miss", () => {
  const filler =
    "boilerplate zoning district setback provisions and definitions. "
      .repeat(400); // ~25 KB, far over budget
  const deep =
    "The maximum floor area ratio in the C-2 commercial district is 2.5.";
  const text = filler + deep + " " + filler;
  const query =
    "What maximum floor area ratio applies in a C-2 commercial district?";

  const out = selectJudgeSpans(query, text);
  assert(
    out.length <= 1500 + 8,
    `emitted text must respect budget, got ${out.length}`,
  );
  assert(
    out.includes("floor area ratio in the C-2 commercial district is 2.5"),
    "query-relevant deep span must be surfaced",
  );
  // And it must still include the head (never regress below section-opening ctx).
  assert(out.startsWith(text.slice(0, 200)), "head must always be included");
});

// ── selectJudgeSpans: never regresses below the old head-600 floor ────────────
Deno.test("output always covers the head floor for an over-budget row", () => {
  const text = "ALPHA_HEAD_MARKER " + "x".repeat(5000) + " OMEGA_TAIL_MARKER";
  const out = selectJudgeSpans("nonexistent-term-zzz", text);
  assert(
    out.includes("ALPHA_HEAD_MARKER"),
    "head marker must be present even with no query-term match",
  );
  // With no matching term, only the head is emitted — bounded, not the whole row.
  assert(
    !out.includes("OMEGA_TAIL_MARKER"),
    "tail must not appear without a match",
  );
  assert(
    out.length <= 1500 + 8,
    "no-match output stays within head/budget bound",
  );
});

// ── selectJudgeSpans: budget parameter is honoured (mutant-parameter check) ───
Deno.test("shrinking the budget parameter reproduces the pre-fix blindness", () => {
  // Simulate an un-widened mutant by passing the old 600 budget explicitly.
  const mutant = selectJudgeSpans(
    TEMPORAL_005_QUERY,
    TEMPORAL_005_TEXT,
    600,
    600,
    350,
  );
  assert(
    !mutant.includes("Class 2 misdemeanor"),
    "budget=600 must reproduce the pre-fix miss (confirms budget is load-bearing)",
  );
});

// ── KNOWN LIMITATION (documented, not a regression): deep decisive text using
// only common+frequent query terms can be missed, degrading to ~head-truncation.
// Locks the behaviour so it is not mistaken for a bug or assumed "fixed" later.
Deno.test("KNOWN LIMITATION: deep clause of only common+frequent terms is missed (== head-600, not worse)", () => {
  // "tax"/"rate" appear many times up-document; the decisive $1.12 clause deep in
  // the row uses only those common terms. Rarest-first + 3-windows-per-term lands
  // windows on the earlier occurrences, so the deep clause falls outside budget.
  const noise = "The tax and rate provisions of this article. ".repeat(60); // ~2.7KB
  const deep = "The applicable tax rate is $1.12 per hundred dollars.";
  const text = noise + deep + " " + noise;
  const query = "What is the tax rate?";

  const out = selectJudgeSpans(query, text);
  // Documented failure: the deep value is NOT surfaced...
  assert(
    !out.includes("$1.12"),
    "documents the known miss for common+frequent terms",
  );
  // ...but this is no worse than the old head-600 (which also would not reach it).
  const head600 = text.slice(0, 600) + "…";
  assert(
    !head600.includes("$1.12"),
    "head-600 also missed it — so no regression",
  );
});

// ── judgeQueryTerms: leaner stoplist keeps operative domain words ─────────────
Deno.test("judgeQueryTerms keeps operative words and drops stopwords/years", () => {
  const terms = judgeQueryTerms(
    "What was the tax rate value in 2019 for the county?",
  );
  assert(terms.includes("tax"), "'tax' must survive");
  assert(
    terms.includes("rate"),
    "'rate' must survive (unlike budget stoplist)",
  );
  assert(
    terms.includes("value"),
    "'value' must survive (unlike budget stoplist)",
  );
  assert(!terms.includes("the"), "'the' must be dropped");
  assert(!terms.includes("what"), "'what' must be dropped");
  assert(!terms.includes("2019"), "bare year must be dropped");
});

// ── Real shipping path: serializeChunk end-to-end on a real EnrichedCandidate ─
Deno.test("serializeChunk (real shipping path) emits the decisive clause + metadata", () => {
  const candidate: EnrichedCandidate = {
    key: "ordinance_provisions:test-id",
    table: "ordinance_provisions",
    id: "test-id",
    row: {
      content: TEMPORAL_005_TEXT,
      is_current: true,
      effective_date: "2020-01-01",
    },
    rankBm25: 3,
    rankVector: 2,
    rrfScore: 0.03,
    ancestors: [{
      municode_node_id: "n1",
      title: "Chapter 41 Animals",
      node_depth: 1,
    }],
    municode_node_id: "FACOCO_CH41_S41-2",
    superseded_date: null,
    hasAmendmentHistory: false,
  };

  const block = serializeChunk(candidate, 0, TEMPORAL_005_QUERY);
  assert(block.includes("[1] id=test-id"), "metadata header must be present");
  assert(
    block.includes("municode_node_id=FACOCO_CH41_S41-2"),
    "node id in metadata",
  );
  assert(
    block.includes("Class 2 misdemeanor"),
    "REGRESSION: real serializeChunk must surface the decisive clause",
  );
});
