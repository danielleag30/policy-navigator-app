/**
 * Regression tests for the generalized ordinance current-value prefetch fixes
 * (PR — ordinance prefetch guardrails). Every function under test is the REAL
 * shipping implementation imported from ./index.ts — no reimplementations.
 *
 * FIXTURES ARE REAL ROWS. `_ordinance-gate_fixtures.json` holds five verbatim
 * ordinance_provisions rows pulled from Supabase project ahaurkifxzqsrhwjshbj:
 *   • tot_4_13_2            — genuine transient-occupancy levy (Sec. 4-13-2), 6%
 *   • spurious_encode_2236  — EnCode zoning Article 3 (overlay/CRD, FAR %)
 *   • spurious_4_24_5       — late-payment forfeiture of exemptions (5%)
 *   • spurious_4_24_3_1     — rehab/renovation exemption tiers (up to 25%)
 *   • spurious_4_7_2_1      — BPOL definitions
 * `_budget-order_fixtures.json` holds the two real adopted budget_indicator rows
 * (+ their documents) the live resolver pins for the rate queries: real estate
 * $1.12 and personal property $4.57 (FY2027 adopted). All four spurious sections
 * are the exact rows that hijacked the pin before these fixes (confirmed against
 * the live bm25_ordinance_provisions RPC).
 *
 * Run: deno test --allow-env --allow-read --allow-net --node-modules-dir=auto \
 *   supabase/functions/query-pipeline/_ordinance-gate_test.ts
 */

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role-key",
);

import type { SourceDocument } from "./index.ts";

const {
  budgetIndicatorCandidate,
  extractCurrentValueFromOrdinance,
  hasLevyRateStructure,
  isTaxationOrdinanceRow,
  ordinanceCandidate,
  ordinanceCurrentValueScore,
  resolveDeterministicCurrentValue,
  selectCurrentOrdinanceValueAnchors,
  structuredCurrentValueScore,
} = await import("./index.ts");

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
type Doc = SourceDocument;

const ordFx: Record<string, Row> = JSON.parse(
  await Deno.readTextFile(
    new URL("./_ordinance-gate_fixtures.json", import.meta.url),
  ),
);
const budFx: Record<string, { table: string; row: Row; document: Doc }> = JSON
  .parse(
    await Deno.readTextFile(
      new URL("./_budget-order_fixtures.json", import.meta.url),
    ),
  );

// ── Small local assert helpers (match rrf_test.ts's dependency-free style) ────
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}
function inBand(score: number, lo: number, hi: number, msg: string): void {
  assert(score >= lo && score < hi, `${msg}: ${score} not in [${lo}, ${hi})`);
}

// Real hijacking subjects, keyed to the query that surfaced each spurious row
// against the live RPC.
const TOT_Q = "what is the current transient occupancy tax rate";
const RE_Q = "what is the current real estate tax rate";
const PP_Q = "what is the current personal property tax rate";

const SPURIOUS: Array<{ name: string; query: string }> = [
  { name: "spurious_encode_2236", query: PP_Q },
  { name: "spurious_4_24_5", query: RE_Q },
  { name: "spurious_4_24_3_1", query: RE_Q },
  { name: "spurious_4_7_2_1", query: PP_Q },
];

// ── Fixture sanity: the fixtures really are the rows we think they are ────────
Deno.test("fixtures are the expected real rows", () => {
  assertEqual(
    ordFx.tot_4_13_2.municode_node_id,
    "FACOCO_CH4TAFI_ART13TROCTA_S4-13-2LEAMTA",
    "TOT node id",
  );
  assertEqual(
    ordFx.spurious_encode_2236.source_type,
    "encode_zoning",
    "encode:2236 source_type",
  );
  assertEqual(
    Number(budFx.budget_real_estate.row.value_actual),
    1.12,
    "RE value",
  );
  assertEqual(
    Number(budFx.budget_personal_property.row.value_actual),
    4.57,
    "PP value",
  );
  assertEqual(
    budFx.budget_real_estate.document.budget_stage,
    "adopted",
    "RE budget stage",
  );
});

// ── FIX ①: levy-language gate ─────────────────────────────────────────────────
Deno.test("① hasLevyRateStructure: genuine TOT passes, all four spurious fail", () => {
  assert(
    hasLevyRateStructure(ordFx.tot_4_13_2.content),
    "genuine TOT levy text must pass the levy-language gate",
  );
  for (const { name } of SPURIOUS) {
    assert(
      !hasLevyRateStructure(ordFx[name].content),
      `${name} must FAIL the levy-language gate (no rate-setting structure)`,
    );
  }
});

Deno.test("① extractCurrentValueFromOrdinance pins 6% on TOT, null on every spurious row", () => {
  const tot = ordinanceCandidate(ordFx.tot_4_13_2);
  assertEqual(
    extractCurrentValueFromOrdinance(TOT_Q, tot),
    "6%",
    "TOT must still resolve to 6% (preserved behavior)",
  );
  for (const { name, query } of SPURIOUS) {
    const c = ordinanceCandidate(ordFx[name]);
    assertEqual(
      extractCurrentValueFromOrdinance(query, c),
      null,
      `${name} must yield null (fall-through), never a wrong value`,
    );
  }
});

Deno.test("① ordinanceCurrentValueScore: TOT scores in ordinance band, spurious score 0", () => {
  const tot = ordinanceCandidate(ordFx.tot_4_13_2);
  inBand(
    ordinanceCurrentValueScore(TOT_Q, tot),
    2_000_000,
    3_000_000,
    "TOT ordinance score band",
  );
  for (const { name, query } of SPURIOUS) {
    const c = ordinanceCandidate(ordFx[name]);
    assertEqual(
      ordinanceCurrentValueScore(query, c),
      0,
      `${name} must score 0 so it can never pin`,
    );
  }
});

// ── FIX ②: budget-first ordering (band separation on real rows) ──────────────
Deno.test("② adopted budget_indicator band (≥3M) strictly outranks the ordinance band (<3M)", () => {
  const re = budgetIndicatorCandidate(budFx.budget_real_estate.row);
  const reDoc = budFx.budget_real_estate.document;
  const pp = budgetIndicatorCandidate(budFx.budget_personal_property.row);
  const ppDoc = budFx.budget_personal_property.document;
  const tot = ordinanceCandidate(ordFx.tot_4_13_2);

  const reScore = structuredCurrentValueScore(RE_Q, re, reDoc);
  const ppScore = structuredCurrentValueScore(PP_Q, pp, ppDoc);
  const totScore = ordinanceCurrentValueScore(TOT_Q, tot);

  inBand(reScore, 3_000_000, 4_000_000, "real-estate budget band");
  inBand(ppScore, 3_000_000, 4_000_000, "personal-property budget band");
  inBand(totScore, 2_000_000, 3_000_000, "TOT ordinance band");
  // The core invariant of fix ②: an adopted budget indicator always outscores
  // any ordinance anchor, so a qualifying budget indicator wins the pin.
  assert(
    reScore > totScore && ppScore > totScore,
    `budget band must dominate ordinance band (re=${reScore}, pp=${ppScore}, tot=${totScore})`,
  );
});

Deno.test("② resolveDeterministicCurrentValue pins the adopted budget row for a rate query", () => {
  const re = budgetIndicatorCandidate(budFx.budget_real_estate.row);
  const reDoc = budFx.budget_real_estate.document;
  const documents = new Map<string, Doc>([[reDoc.id, reDoc]]);
  const winner = resolveDeterministicCurrentValue(RE_Q, [re], documents);
  assert(winner !== null, "real-estate rate query must pin a winner");
  assertEqual(
    winner!.table,
    "budget_indicators",
    "real-estate winner must be a budget_indicator",
  );
});

// ── FIX ③: scope the ordinance pool ──────────────────────────────────────────
Deno.test("③ isTaxationOrdinanceRow excludes EnCode zoning, keeps CH4 taxation rows", () => {
  assert(
    !isTaxationOrdinanceRow(ordFx.spurious_encode_2236),
    "EnCode zoning row must be excluded from the ordinance pool",
  );
  assert(
    isTaxationOrdinanceRow(ordFx.tot_4_13_2),
    "TOT (FACOCO_CH4TAFI) must be in scope",
  );
  for (
    const name of ["spurious_4_24_5", "spurious_4_24_3_1", "spurious_4_7_2_1"]
  ) {
    assert(
      isTaxationOrdinanceRow(ordFx[name]),
      `${name} is a real CH4 row — kept by scope, filtered later by the levy gate`,
    );
  }
});

// ── End-to-end selection on real rows (fixes ①+③ together) ───────────────────
Deno.test("selectCurrentOrdinanceValueAnchors pins TOT (6%) from the full real pool", () => {
  const pool = Object.values(ordFx).filter((r) =>
    typeof r === "object" && r?.id
  );
  const anchors = selectCurrentOrdinanceValueAnchors(TOT_Q, pool);
  assertEqual(
    anchors.length,
    1,
    "exactly one anchor (the TOT section) should survive",
  );
  assertEqual(
    anchors[0].municode_node_id,
    "FACOCO_CH4TAFI_ART13TROCTA_S4-13-2LEAMTA",
    "the surviving anchor must be the genuine TOT section",
  );
  assertEqual(
    extractCurrentValueFromOrdinance(TOT_Q, anchors[0]),
    "6%",
    "the pinned anchor must yield 6%",
  );
});

Deno.test("selectCurrentOrdinanceValueAnchors falls through for real estate (no ordinance levy section exists)", () => {
  const pool = Object.values(ordFx).filter((r) =>
    typeof r === "object" && r?.id
  );
  const anchors = selectCurrentOrdinanceValueAnchors(RE_Q, pool);
  assertEqual(
    anchors.length,
    0,
    "real-estate has no ordinance rate section — must fall through, never pin a spurious row",
  );
});

// ── The lesson of the regression: a LONE spurious qualifier must fall through ──
// Before the fix, the blind safety gate only fired on cross-section DISAGREEMENT,
// so a single spurious qualifier pinned with full confidence. Each spurious row,
// alone in the pool, must now yield NO anchor.
Deno.test("lone spurious qualifier falls through (no blind single-row pin)", () => {
  for (const { name, query } of SPURIOUS) {
    const anchors = selectCurrentOrdinanceValueAnchors(query, [ordFx[name]]);
    assertEqual(
      anchors.length,
      0,
      `${name} alone must fall through — a single spurious qualifier must never pin`,
    );
  }
});
