/**
 * Regression tests for the growth-vs-rate resolver fixes (Defects A / C / D):
 * confidently serving a revenue-GROWTH or revenue-SHARE percentage as a current
 * tax RATE. Every function under test is the REAL shipping implementation
 * imported from ./index.ts — no reimplementations.
 *
 * FIXTURES ARE REAL ROWS. `_rate-guard_fixtures.json` holds verbatim
 * budget_indicators rows (+ their documents) pulled from Supabase project
 * ahaurkifxzqsrhwjshbj, the exact rows the live resolver ranked for these queries:
 *   • pp_correct        019f5736-0f82-7f8b-91a4-e7f4b17e492a  Personal Property Tax rate  $4.57/$100  (adopted)
 *   • pp_growth         019f52f3-d30f-780f-a452-0e7f02c1bcdb  "Personal Property Taxes increase"  3.1 percent  (adopted doc, growth metric)
 *   • re_adopted_112    019f548a-33de-72ff-9d15-45e0120c8ac6  Real Estate tax rate  $1.12/$100  (adopted, live pin)
 *   • re_adopted_1225   019f53e1-e188-718f-b7f4-d9f0052b34cc  Real Estate Tax rate  $1.1225/$100 (adopted CEX letter)
 *   • re_advertised_1225 019f4722-feba-7bee-934e-c4e4586ea93c Real Estate Tax rate $1.1225/$100 (advertised)
 *   • ws_real_988       019f4ebc-41e2-77fc-b81b-5560cc16e992  Sewer Service Charge  $9.88/1,000 gal (advertised source)
 *   • ws_wrong_pct      019f5689-7cc0-7207-bc93-f8c62cd959ec  "Fixed Charge Revenue Percentage"  25.5 percent  (adopted doc, share metric)
 *
 * Live-confirmed defect (production v59): "current personal property tax rate" →
 * "3.1 percent" (cites pp_growth) and "current water/sewer rate" → "25.5 percent"
 * (cites ws_wrong_pct), both uncaveated.
 *
 * Run: deno test --allow-env --allow-read --allow-net --node-modules-dir=auto \
 *   supabase/functions/query-pipeline/_growth-rate-guard_test.ts
 */

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role-key",
);

import type { EnrichedCandidate, SourceDocument } from "./index.ts";

const {
  budgetIndicatorCandidate,
  structuredCurrentValueScore,
  resolveDeterministicCurrentValue,
  deterministicCurrentValueDraft,
  formatBudgetValue,
} = await import("./index.ts");

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const fx: Record<
  string,
  { table: string; row: Row; document: SourceDocument }
> = JSON.parse(
  await Deno.readTextFile(
    new URL("./_rate-guard_fixtures.json", import.meta.url),
  ),
);

// ── dependency-free assert helpers (match rrf_test.ts / _ordinance-gate style) ─
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

const PP_Q = "what is the current personal property tax rate";
const RE_Q = "what is the current real estate tax rate";
const WS_Q = "what is the current water/sewer rate";

function cand(key: string): EnrichedCandidate {
  return budgetIndicatorCandidate(fx[key].row);
}
function docOf(key: string): SourceDocument {
  return fx[key].document;
}
function score(query: string, key: string): number {
  return structuredCurrentValueScore(query, cand(key), docOf(key));
}
// Build the document Map resolveDeterministicCurrentValue expects (keyed by
// row.document_id) from a set of fixture keys.
function docsFor(keys: string[]): Map<string, SourceDocument> {
  const m = new Map<string, SourceDocument>();
  for (const k of keys) m.set(fx[k].row.document_id as string, docOf(k));
  return m;
}

// ── sanity: fixtures are the expected real rows ──────────────────────────────
Deno.test("fixtures are the expected real growth-vs-rate rows", () => {
  assertEqual(fx.pp_growth.row.unit, "percent", "pp_growth unit");
  assertEqual(fx.pp_growth.row.value_actual, 3.1, "pp_growth value");
  assertEqual(fx.ws_wrong_pct.row.indicator_name, "Fixed Charge Revenue Percentage", "ws_wrong name");
  assertEqual(fx.ws_wrong_pct.row.value_actual, 25.5, "ws_wrong value");
  assertEqual(fx.pp_correct.row.value_actual, 4.57, "pp_correct value");
  assertEqual(fx.re_adopted_112.row.value_actual, 1.12, "re value");
  assertEqual(fx.re_advertised_1225.document.budget_stage, "advertised", "advertised stage");
});

// ── Defect A: growth/share metrics never score as a current rate ─────────────
Deno.test("A: growth metric 'Personal Property Taxes increase' (3.1%) scores 0 for a tax-rate query", () => {
  assertEqual(score(PP_Q, "pp_growth"), 0, "pp_growth must not be a rate candidate");
});

Deno.test("A: share metric 'Fixed Charge Revenue Percentage' (25.5%) scores 0 for a non-tax rate query", () => {
  // "water/sewer rate" carries no 'tax', so it routes through the rate|fee|charge
  // branch — the branch where the bare word "charge" in the name used to admit it.
  assertEqual(score(WS_Q, "ws_wrong_pct"), 0, "ws_wrong_pct must not be a rate candidate");
});

Deno.test("A: the genuine rate rows still score in the adopted budget band (not collateral damage)", () => {
  const pp = score(PP_Q, "pp_correct");
  const re = score(RE_Q, "re_adopted_112");
  assert(pp >= 3_000_000 && pp < 4_000_000, `pp_correct in band, got ${pp}`);
  assert(re >= 3_000_000 && re < 4_000_000, `re_112 in band, got ${re}`);
});

// ── Defect A end-to-end via the real resolver ────────────────────────────────
Deno.test("A: resolver pins $4.57 for personal property when both the rate row and the growth row are present", () => {
  const winner = resolveDeterministicCurrentValue(
    PP_Q,
    [cand("pp_growth"), cand("pp_correct")],
    docsFor(["pp_growth", "pp_correct"]),
  );
  assert(winner !== null, "expected a pin");
  assertEqual(winner!.table, "budget_indicators", "winner table");
  assertEqual(
    formatBudgetValue(winner!.row.value_actual, winner!.row.unit),
    formatBudgetValue(4.57, "dollars per $100 of assessed value"),
    "personal property must pin $4.57, never 3.1 percent",
  );
});

Deno.test("A: personal-property growth row ALONE cannot pin — resolver falls through", () => {
  const winner = resolveDeterministicCurrentValue(
    PP_Q,
    [cand("pp_growth")],
    docsFor(["pp_growth"]),
  );
  assertEqual(winner, null, "growth row alone must fall through, not pin 3.1 percent");
});

Deno.test("A: water/sewer share row (25.5%) cannot pin — resolver falls through to the caveated path", () => {
  // ws_real_988 is an advertised-source row (scores 0); ws_wrong_pct is now
  // rejected as a share metric. So there is no pinnable budget candidate.
  const winner = resolveDeterministicCurrentValue(
    WS_Q,
    [cand("ws_wrong_pct"), cand("ws_real_988")],
    docsFor(["ws_wrong_pct", "ws_real_988"]),
  );
  assertEqual(winner, null, "water/sewer must fall through, never pin 25.5 percent");
});

// ── Corroboration tie-break: distinct-document majority resolves the REAL tie ──
// The live 7-vs-1 split: $1.12 is attested across many distinct adopted documents,
// while $1.1225 appears ONLY in the single CEX transmittal letter (the advertised
// letter reprinted inside the adopted package). Both $1.1225 rows and the $1.12
// rows are budget_stage='adopted', fiscal_year=2027 — indistinguishable on stage,
// year, and effective_date. The prior 3-row subset hid the tie by including just
// ONE $1.12 document; with the real competing rows present the resolver must pin
// $1.12 by DISTINCT-DOCUMENT majority — never fall through, never flip to $1.1225.
const RE_112_KEYS = [
  "re_adopted_112",
  "re_112_trends",
  "re_112_summary",
  "re_112_chairman",
  "re_112_package",
];
const RE_1225_KEYS = ["re_adopted_1225", "re_1225_cex2"];

Deno.test("corroboration fixtures: $1.12 spans 5 DISTINCT documents; both $1.1225 rows share the one CEX document", () => {
  const docs112 = new Set(RE_112_KEYS.map((k) => fx[k].row.document_id));
  const docs1225 = new Set(RE_1225_KEYS.map((k) => fx[k].row.document_id));
  assertEqual(docs112.size, 5, "5 distinct $1.12 documents");
  assertEqual(docs1225.size, 1, "both $1.1225 rows are the single CEX Letter document");
  for (const k of RE_1225_KEYS) {
    assertEqual(fx[k].row.value_actual, 1.1225, `${k} is a $1.1225 row`);
    assertEqual(fx[k].document.budget_stage, "adopted", `${k} is adopted-stage`);
  }
});

Deno.test("corroboration: real $1.12 (5 docs) vs $1.1225 (1 CEX doc) tie → pins $1.12 by distinct-document majority", () => {
  const keys = [...RE_112_KEYS, ...RE_1225_KEYS, "re_advertised_1225"];
  const winner = resolveDeterministicCurrentValue(
    RE_Q,
    keys.map(cand),
    docsFor(keys),
  );
  assert(winner !== null, "expected a real-estate pin, not a fall-through to flippy narrative");
  const w = winner!;
  assertEqual(w.table, "budget_indicators", "winner is a budget_indicator pin");
  assertEqual(w.row.value_actual, 1.12, "must pin $1.12, never the reprinted-advertised $1.1225");
  const rendered = formatBudgetValue(w.row.value_actual, w.row.unit) ?? "";
  assert(
    rendered.includes("$1.12") && !rendered.includes("$1.1225"),
    `real estate value renders as $1.12, got ${rendered}`,
  );
});

Deno.test("corroboration: order-independent — pins $1.12 even when the $1.1225 rows are listed first", () => {
  const keys = [...RE_1225_KEYS, "re_advertised_1225", ...RE_112_KEYS];
  const winner = resolveDeterministicCurrentValue(
    RE_Q,
    keys.map(cand),
    docsFor(keys),
  );
  assert(winner !== null, "expected a real-estate pin regardless of candidate order");
  assertEqual(winner!.row.value_actual, 1.12, "distinct-document majority is order-independent");
});

// ── Corroboration must NOT adjudicate across DIFFERENT charges ───────────────
// "water and sewer rate" has two adopted figures that are DIFFERENT metrics, not
// competing readings of one rate: the $9.88/1,000-gal service charge and the
// $55.78/quarter base charge (~5.6× apart). The most-DOCUMENTED figure is the base
// charge, so a naive distinct-document majority would pin $55.78 as "the rate" —
// wrong. The same-rate closeness guard must reject the wide spread and fall through
// so the LLM composes the compound answer (service charge + base charge).
Deno.test("safety: water/sewer service ($9.88/1,000 gal) vs base ($55.78/quarter) → wide spread → falls through", () => {
  const keys = ["ws_service_988_adopted", "ws_base_5578_adopted"];
  const winner = resolveDeterministicCurrentValue(WS_Q, keys.map(cand), docsFor(keys));
  assertEqual(winner, null, "different charges must not corroborate into a single wrong pin");
});

Deno.test("safety: both water/sewer charges are pinnable adopted rows (guard, not a gate, causes the fall-through)", () => {
  // Confirm the fall-through above is the closeness guard, not either row being
  // filtered out: each scores in the adopted budget band on its own.
  assert(score(WS_Q, "ws_service_988_adopted") >= 3_000_000, "service charge is pinnable");
  assert(score(WS_Q, "ws_base_5578_adopted") >= 3_000_000, "base charge is pinnable");
});

// ── Defect C is PRESERVED as the residual fall-through ───────────────────────
// When only ONE $1.12 document reaches the resolver, distinct-document counts tie
// 1-vs-1, corroboration cannot decide, and Defect C's guard fires — no coin-flip.
// In production the prefetch dedupe (fetchCurrentBudgetIndicatorRows) guarantees
// ≥2 distinct $1.12 documents are anchored, so this degenerate set cannot arise
// there; the test pins down the safety floor of the tie-break itself.
Deno.test("C preserved: a lone $1.12 document tied 1-vs-1 with the CEX $1.1225 document → falls through (no coin-flip)", () => {
  const keys = ["re_adopted_112", "re_adopted_1225", "re_1225_cex2"];
  const winner = resolveDeterministicCurrentValue(
    RE_Q,
    keys.map(cand),
    docsFor(keys),
  );
  assertEqual(winner, null, "1-vs-1 distinct-document tie must fall through, never coin-flip a pin");
});

// ── Defect C: exact-score-tie disagreement falls through; agreement pins ─────
// Twins derived from a REAL row (same document + prose ⇒ identical score) with a
// changed value + id — the deterministic way to exercise the tie branch.
function twin(key: string, id: string, value: number): EnrichedCandidate {
  const row = { ...fx[key].row, id, value_actual: value };
  return budgetIndicatorCandidate(row);
}
Deno.test("C: two pinnable budget rows TIED at the same score but disagreeing on value → fall through", () => {
  const a = twin("pp_correct", "aaaaaaaa-0000-7000-8000-000000000001", 4.57);
  const b = twin("pp_correct", "aaaaaaaa-0000-7000-8000-000000000002", 9.99);
  const docs = new Map([[fx.pp_correct.row.document_id as string, docOf("pp_correct")]]);
  // sanity: the twins really are tied
  const sa = structuredCurrentValueScore(PP_Q, a, docOf("pp_correct"));
  const sb = structuredCurrentValueScore(PP_Q, b, docOf("pp_correct"));
  assertEqual(sa, sb, "twins must be score-tied for this probe to be meaningful");
  const winner = resolveDeterministicCurrentValue(PP_Q, [a, b], docs);
  assertEqual(winner, null, "tied disagreement must fall through, not coin-flip a pin");
});

Deno.test("C: tied rows that AGREE on value still pin (guard is disagreement-only)", () => {
  const a = twin("pp_correct", "bbbbbbbb-0000-7000-8000-000000000001", 4.57);
  const b = twin("pp_correct", "bbbbbbbb-0000-7000-8000-000000000002", 4.57);
  const docs = new Map([[fx.pp_correct.row.document_id as string, docOf("pp_correct")]]);
  const winner = resolveDeterministicCurrentValue(PP_Q, [a, b], docs);
  assert(winner !== null, "agreeing rows must still pin");
  assertEqual(
    formatBudgetValue(winner!.row.value_actual, winner!.row.unit),
    formatBudgetValue(4.57, "dollars per $100 of assessed value"),
    "agreeing rows pin the shared value",
  );
});

// ── Defect D: a budget_indicator pin ships a review caveat, not caveats: [] ───
Deno.test("D: deterministic budget_indicator draft carries the structured-value review caveat", () => {
  const draft = deterministicCurrentValueDraft(
    PP_Q,
    cand("pp_correct"),
    docsFor(["pp_correct"]),
  );
  assert(draft !== null, "expected a draft");
  assert(
    draft!.answer.includes("$4.57") || draft!.answer.includes("4.57"),
    "draft asserts the value",
  );
  assert(
    draft!.answer.includes(
      "auto-extracted from a budget document's structured indicators",
    ),
    "budget_indicator draft must carry the review caveat in the answer text",
  );
});
