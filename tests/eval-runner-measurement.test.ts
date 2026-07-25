/**
 * Tests for the eval MEASUREMENT-layer fixes:
 *   #2 widened refusal detection (partial / hedged refusals), and
 *   #4 the correctness-vs-availability split metric.
 *
 * These import and exercise the REAL shipping code from eval/runner.ts
 * (`isRefusalAnswer`, `caseExpectsAnswer`, `computeSummaryMetrics`) — NOT a
 * re-implemented copy. This repo has a documented history of tests-of-copies
 * passing while shipping code was broken; mutating the shipped functions in
 * runner.ts MUST turn these red (see the mutation-probe evidence in the PR).
 *
 * Importing runner.ts is side-effect-free: all live-run machinery (CLI, env,
 * network, DB) is guarded behind `import.meta.main`.
 *
 * The answer strings below are the REAL pipeline outputs from the
 * post-remediation run (eval-results-post-remediation-20260725T025006Z.json),
 * copied verbatim — not hand-invented. Each is labelled with its source case
 * and its ground-truth expectation from the fixtures.
 */

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  caseExpectsAnswer,
  type CaseResult,
  computeSummaryMetrics,
  isRefusalAnswer,
} from "../eval/runner.ts";
import type { EvalCriterion } from "../eval/schema.ts";

// ---------------------------------------------------------------------------
// REAL answers that ARE partial/hedged refusals (fixtures expect is_refusal).
// The original REFUSAL_PATTERNS missed every one of these — the exact
// undercount the Fable audit predicted verbatim.
// ---------------------------------------------------------------------------

const PARTIAL_REFUSALS: Record<string, string> = {
  "refusal-state-law-002":
    "The provided documents do not state the mandatory minimum sentences for DUI convictions in Virginia. However, for individuals convicted of a violation of Section 83-4-7.1.1 or subsection (b) of Section 83-4-7 (including any second offense thereunder), the court shall impose the authorized sentence [Fairfax County Code of Ordinances — Supplement 179, page n/a, retrieved 2026-06-24], and such persons shall enter into an alcohol safety action program certified by the Commission on the Virginia Alcohol Safety Action Program (VASAP) with leave of court or upon court order [Fairfax County Code of Ordinances — Supplement 179, page n/a, retrieved 2026-06-24].",
  "refusal-other-jurisdiction-008":
    "The provided documents do not specify general building codes for Dulles Airport property, but they outline specific standards for certain facilities and areas adjacent to the airport:\n\n*   **Support Rail Transit Facilities:** Support rail transit facilities located in the right-of-way of the Dulles International Airport Access Highway, the combined Dulles International Airport Access Highway and Dulles Toll Road, or an interstate highway are not subject to the standards in subsection 8100.7 [Fairfax County Zoning Ordinance (EnCode), page n/a, retrieved 2026-07-10].",
  "refusal-realtime-011":
    "The provided documents do not specify a commercial vacancy rate specifically for Tysons Corner. However, for Fairfax County, the direct office vacancy rate for year-end 2025 was 17.4 percent [Budget Document — 2026-07-12, page 2, retrieved 2026-07-12], which represents a 0.4 percentage point reduction from the year-end 2024 rate of 17.8 percent [Budget Document — 2026-07-12, page 2, retrieved 2026-07-12].\n\nCaveat: This narrative-derived current value may need source-date review.",
  "refusal-realtime-014":
    "Based on the provided documents, there is no mention of a general budget surplus for Fairfax County's current fiscal year. The documents provide specific financial data for the FY 2024 Third Quarter Review, which noted a net balance of $229,126 remaining after Board adjustments [Board Minutes — 2024-04-26, page 1, retrieved 2026-07-20].\n\nCaveat: This narrative-derived current value may need source-date review.",
  "out-of-corpus-010":
    "The provided documents do not contain information regarding a data center moratorium policy for Fairfax County. The documents only mention the following related to data centers:\n\n*   **Tax Exemptions:** There are proposals requiring data centers to meet specific environmental standards to qualify for equipment sales and use tax exemptions starting July 1, 2027 [Board Minutes — 2026-02-27, page 1, retrieved 2026-07-22].",
};

// ---------------------------------------------------------------------------
// REAL answers that are GENUINE ASSERTIONS (must NOT be scored as refusals).
// Critically includes refusal-realtime-012 — a FALSE assertion (stale
// officeholder) that the project's policy needs to stay in the CORRECTNESS
// bucket, and retrieval-003 whose decline clause is *secondary*.
// ---------------------------------------------------------------------------

const GENUINE_ASSERTIONS: Record<string, string> = {
  "refusal-realtime-012":
    "Based on the provided documents, Sharon Bulova is listed as the supervisor for the Chairman district [Board Summary — 2019-12-10, page 1, retrieved 2026-07-09].\n\nCaveat: This narrative-derived current value may need source-date review.",
  "refusal-advice-019":
    "Yes, it is generally legal to build a 6-foot fence on the property line in Fairfax County. According to the Zoning Ordinance, fences or walls can be built up to the lot line at the maximum allowed height [Fairfax County Zoning Ordinance (EnCode), page n/a, retrieved 2026-07-10].",
  "retrieval-003":
    "Yes, every dealer is required to secure a permit [Fairfax County Code of Ordinances — Supplement 179, page n/a, retrieved 2026-06-24]. The provided documents do not mention any exemptions for dealers who already hold permits from other localities.",
  "refusal-state-law-004":
    "The Virginia Dillon Rule imposes limitations on the governmental powers of counties [Board Summary — 1993-12-06, page 36, retrieved 2026-07-18].",
  "out-of-corpus-003":
    "To operate delivery robots (Shared Mobility Devices) on sidewalks, Fairfax County requires the following:\n\n* **Operator's Permit**: Applicants must apply for an Operator's Permit using forms provided by the Department [Fairfax County Code of Ordinances — Supplement 179, page n/a, retrieved 2026-06-24].",
};

// The plain, outright refusal string the pipeline emits by default — must stay
// detected (backward-compat with the original patterns).
const OUTRIGHT_REFUSAL = "not in the documents";

Deno.test("isRefusalAnswer: widened patterns catch the real partial/hedged refusals", () => {
  for (const [caseId, answer] of Object.entries(PARTIAL_REFUSALS)) {
    assert(
      isRefusalAnswer(answer),
      `[${caseId}] partial refusal must be detected as a refusal:\n  ${answer.slice(0, 120)}…`,
    );
  }
});

Deno.test("isRefusalAnswer: genuine assertions are NOT misread as refusals", () => {
  for (const [caseId, answer] of Object.entries(GENUINE_ASSERTIONS)) {
    assertFalse(
      isRefusalAnswer(answer),
      `[${caseId}] genuine assertion must NOT be scored as a refusal:\n  ${answer.slice(0, 120)}…`,
    );
  }
});

Deno.test("isRefusalAnswer: the stale-officeholder FALSE assertion stays an assertion (correctness, not availability)", () => {
  // refusal-realtime-012 asserts a 2019 officeholder as current. Under the
  // project's correctness-over-availability policy this is a *severe* failure
  // and must remain classified as an ASSERTION so the split can charge it to
  // correctness — never laundered into the cheap availability bucket.
  assertFalse(isRefusalAnswer(GENUINE_ASSERTIONS["refusal-realtime-012"]));
});

Deno.test("isRefusalAnswer: retrieval-003 leads with a real answer despite a trailing 'documents do not mention' clause", () => {
  // Anchoring guard: the decline clause is secondary, so this is an assertion.
  assertFalse(isRefusalAnswer(GENUINE_ASSERTIONS["retrieval-003"]));
});

Deno.test("isRefusalAnswer: outright refusal and empty answers still detected (backward-compat)", () => {
  assert(isRefusalAnswer(OUTRIGHT_REFUSAL));
  assert(isRefusalAnswer(""));
  assert(isRefusalAnswer("   "));
  // A couple of the original five patterns, unchanged:
  assert(isRefusalAnswer("I cannot find that in the documents."));
  assert(isRefusalAnswer("That is outside the scope of the corpus."));
});

// ---------------------------------------------------------------------------
// caseExpectsAnswer — driven by the REAL shipped fixtures.
// ---------------------------------------------------------------------------

interface RawCase {
  id: string;
  criteria: EvalCriterion[];
}

async function loadCases(file: string): Promise<RawCase[]> {
  const url = new URL(`../eval/cases/${file}`, import.meta.url);
  return JSON.parse(await Deno.readTextFile(url)) as RawCase[];
}

Deno.test("caseExpectsAnswer: refusal fixtures expect a refusal; citation fixtures expect an answer", async () => {
  const refusals = await loadCases("refusal.json");
  for (const c of refusals) {
    if (c.criteria.some((cr) => cr.check.type === "is_refusal")) {
      assertFalse(
        caseExpectsAnswer(c.criteria),
        `[${c.id}] has an is_refusal criterion → must NOT expect an answer`,
      );
    }
  }
  const cites = await loadCases("citation-historical.json");
  const withCite = cites.find((c) => c.criteria.some((cr) => cr.check.type === "cites_chunk"));
  assert(withCite, "expected at least one citation case");
  assert(
    caseExpectsAnswer(withCite!.criteria),
    "a citation case (no is_refusal) must expect an answer",
  );
});

// ---------------------------------------------------------------------------
// computeSummaryMetrics — the correctness/availability split.
// ---------------------------------------------------------------------------

function mk(partial: Partial<CaseResult> & { status: CaseResult["status"] }): CaseResult {
  return {
    case_id: partial.case_id ?? "x",
    category: partial.category ?? "citation_accuracy_textual",
    criteria_results: [],
    response_ms: 0,
    ...partial,
  };
}

Deno.test("computeSummaryMetrics: splits correctness from availability on a deterministic fixture set", () => {
  const results: CaseResult[] = [
    // A: expected answer, asserted, correct  → correctness hit, availability answered
    mk({ case_id: "A", status: "pass", expects_answer: true, refused: false }),
    // B: expected answer, asserted, WRONG    → correctness miss, availability answered
    mk({ case_id: "B", status: "fail", expects_answer: true, refused: false }),
    // C: expected answer, REFUSED            → availability loss (cheap), not asserted
    mk({ case_id: "C", status: "fail", expects_answer: true, refused: true }),
    // D: refusal expected, correctly refused → correct refusal, outside availability denom
    mk({ case_id: "D", status: "pass", expects_answer: false, refused: true }),
    // E: refusal expected, ASSERTED anyway   → false-premise assertion (severe)
    mk({ case_id: "E", status: "fail", expects_answer: false, refused: false }),
    // F/G excluded from "ran"
    mk({ case_id: "F", status: "error", expects_answer: true }),
    mk({ case_id: "G", status: "skipped", expects_answer: true }),
  ];

  const m = computeSummaryMetrics(results);

  assertEquals(m.total, 7);
  assertEquals(m.skipped, 1);
  assertEquals(m.errored, 1);
  assertEquals(m.ran, 5);
  assertEquals(m.passed, 2);
  assertEquals(m.overallPct, 40);

  // Correctness: asserted = A,B,E; correct = A; one false-premise assertion (E).
  assertEquals(m.correctness.asserted, 3);
  assertEquals(m.correctness.correct, 1);
  assertEquals(m.correctness.pct, 33);
  assertEquals(m.correctness.falseAssertionsWhereRefusalExpected, 1);

  // Availability: expected = A,B,C; answered = A,B; refused = C.
  assertEquals(m.availability.expected, 3);
  assertEquals(m.availability.answered, 2);
  assertEquals(m.availability.refused, 1);
  assertEquals(m.availability.answeredPct, 67);
  assertEquals(m.availability.refusedPct, 33);
});

Deno.test("computeSummaryMetrics: a refusal on an answerable question is availability-only, never a correctness miss", () => {
  // The whole point of the split: C below is a refusal on an answerable case.
  // It must count against AVAILABILITY but must NOT drag down CORRECTNESS
  // (which only scores answers the system chose to assert).
  const results: CaseResult[] = [
    mk({ case_id: "ok", status: "pass", expects_answer: true, refused: false }),
    mk({ case_id: "refused", status: "fail", expects_answer: true, refused: true }),
  ];
  const m = computeSummaryMetrics(results);
  assertEquals(m.correctness.asserted, 1); // only the asserted case
  assertEquals(m.correctness.correct, 1);
  assertEquals(m.correctness.pct, 100); // correctness untouched by the refusal
  assertEquals(m.availability.refused, 1); // refusal charged to availability
  assertEquals(m.availability.answeredPct, 50);
});

Deno.test("computeSummaryMetrics: end-to-end with REAL partial-refusal answers routed through isRefusalAnswer", () => {
  // Build results the way the runner does: refused = isRefusalAnswer(answer).
  // The five real partial refusals are answerable-expected cases the system
  // declined → they must land in availability.refused, not correctness.
  const results: CaseResult[] = Object.entries(PARTIAL_REFUSALS).map(([id, answer]) =>
    mk({
      case_id: id,
      status: "fail",
      answer,
      expects_answer: true,
      refused: isRefusalAnswer(answer),
    })
  );
  const m = computeSummaryMetrics(results);
  assertEquals(m.availability.expected, 5);
  assertEquals(m.availability.refused, 5); // all five correctly detected as declines
  assertEquals(m.correctness.asserted, 0); // none counted as an assertion
});
