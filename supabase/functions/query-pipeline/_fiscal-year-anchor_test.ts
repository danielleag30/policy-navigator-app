/**
 * Regression tests for the DATED LATENT BUG in the structured current-value gate
 * (structuredCurrentValueScore in ./index.ts).
 *
 * THE BUG: the future-projection gate derived its boundary from the WALL CLOCK
 * (`fiscalYear > currentFiscalYear()`, and currentFiscalYear() reads new Date()).
 * Today the wall-clock FY and the corpus FY agree, so out-year FORECAST rows
 * (FY2028..FY2031) are correctly zeroed. But those forecast rows ALREADY sit in the
 * database. On 2027-07-01 currentFiscalYear() ticks to 2028, the FY2028 forecast
 * rows pass the gate, and — because every row in a forecast ladder shares
 * byte-identical prose — they win purely on the `+ fiscalYear` tiebreak addend. A
 * four-years-out projection would be served as "the current rate", triggered by
 * nothing but a calendar tick, with no new data ingested.
 *
 * THE FIX: anchor the boundary to the CORPUS, not the clock —
 * row.fiscal_year > document.fiscal_year  =>  out-year PROJECTION (score 0).
 *
 * Every function under test is the REAL shipping implementation imported from
 * ./index.ts — no reimplementations.
 *
 * FIXTURES ARE REAL ROWS. `_fiscal-year-anchor_fixtures.json` holds verbatim
 * budget_indicators rows (+ their document) pulled from Supabase project
 * ahaurkifxzqsrhwjshbj — a single Sewer/Base charge forecast ladder inside ONE
 * adopted FY2027 document (019f5689-14eb-7eea-a078-b96cc5a6e911):
 *   • sewer_fy2027_own        FY2027 row, $9.88   (the budget's OWN year → current)
 *   • sewer_fy2028_projection FY2028 row, $10.78  (projection published in FY2027)
 *   • base_fy2027_own         FY2027 row, $55.78  (own year → current)
 *   • base_fy2028_projection  FY2028 row, $60.79  (projection published in FY2027)
 * All four carry byte-identical raw_extracted_text, so the prose tiebreak scores
 * them identically and the `+ fiscalYear` addend is the SOLE score differentiator —
 * the exact exposed surface of the bug.
 *
 * Run: deno test --allow-env --allow-read --allow-net --node-modules-dir=auto \
 *   supabase/functions/query-pipeline/_fiscal-year-anchor_test.ts
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
  formatBudgetValue,
  currentFiscalYear,
} = await import("./index.ts");

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const fx: Record<string, { table?: string; row?: Row } & Record<string, unknown>> =
  JSON.parse(
    await Deno.readTextFile(
      new URL("./_fiscal-year-anchor_fixtures.json", import.meta.url),
    ),
  );

const DOC = fx.document as unknown as SourceDocument;

// ── dependency-free assert helpers (match the sibling test files) ────────────
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

const SEWER_Q = "what is the current sewer service charge";
const BASE_Q = "what is the current sewer base charge";

function cand(key: string): EnrichedCandidate {
  return budgetIndicatorCandidate((fx[key] as { row: Row }).row);
}
function score(query: string, key: string): number {
  return structuredCurrentValueScore(query, cand(key), DOC);
}
function docsFor(keys: string[]): Map<string, SourceDocument> {
  const m = new Map<string, SourceDocument>();
  for (const k of keys) {
    m.set((fx[k] as { row: Row }).row.document_id as string, DOC);
  }
  return m;
}

// ── clock stub: only argless `new Date()` / `Date.now()` are frozen; parsing a
//    date string still works, so unrelated date logic is unaffected ──────────
const RealDate = Date;
function withFrozenClock<T>(iso: string, fn: () => T): T {
  const fixed = new RealDate(iso).getTime();
  class FakeDate extends RealDate {
    // deno-lint-ignore no-explicit-any
    constructor(...args: any[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [number]));
    }
    static override now(): number {
      return fixed;
    }
  }
  globalThis.Date = FakeDate as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// ── sanity: fixtures are the expected real ladder ─────────────────────────────
Deno.test("fixtures: one FY2027 adopted document holding FY2027 own-year and FY2028 projection rows", () => {
  assertEqual(DOC.fiscal_year, 2027, "document is the FY2027 budget");
  assertEqual(DOC.budget_stage, "adopted", "document is adopted");
  assertEqual((fx.sewer_fy2027_own as { row: Row }).row.fiscal_year, 2027, "own row FY");
  assertEqual((fx.sewer_fy2027_own as { row: Row }).row.value_actual, 9.88, "own row value");
  assertEqual((fx.sewer_fy2028_projection as { row: Row }).row.fiscal_year, 2028, "projection row FY");
  assertEqual((fx.sewer_fy2028_projection as { row: Row }).row.value_actual, 10.78, "projection row value");
  // The exposed surface: identical prose ⇒ the +fiscalYear addend is the sole decider.
  assertEqual(
    (fx.sewer_fy2027_own as { row: Row }).row.raw_extracted_text,
    (fx.sewer_fy2028_projection as { row: Row }).row.raw_extracted_text,
    "own-year and projection rows share byte-identical prose",
  );
});

// ── TODAY (real clock): the projection is already zeroed, own-year scores in band ─
Deno.test("today: FY2027 own-year sewer charge scores in the adopted budget band", () => {
  const s = score(SEWER_Q, "sewer_fy2027_own");
  assert(s >= 3_000_000 && s < 4_000_000, `own-year must be pinnable, got ${s}`);
});

Deno.test("today: FY2028 sewer projection scores 0 (out-year projection, not current)", () => {
  assertEqual(score(SEWER_Q, "sewer_fy2028_projection"), 0, "FY2028 projection must score 0 today");
});

Deno.test("today: own-year outranks the projection", () => {
  assert(
    score(SEWER_Q, "sewer_fy2027_own") > score(SEWER_Q, "sewer_fy2028_projection"),
    "FY2027 own-year must outrank the FY2028 projection today",
  );
});

// ── TIME-TRAVEL: the whole point of the fix ──────────────────────────────────
// Freeze the wall clock at 2027-07-01, the boundary where currentFiscalYear()
// ticks to 2028. The corpus-anchored gate must be UNMOVED by the tick: the FY2028
// projection must still score 0 and must NOT win.
Deno.test("time-travel 2027-07-01: currentFiscalYear() really ticks to 2028 (the trigger)", () => {
  withFrozenClock("2027-07-01T00:00:00Z", () => {
    assertEqual(currentFiscalYear(), 2028, "wall-clock FY must tick to 2028 on 2027-07-01");
  });
});

Deno.test("time-travel 2027-07-01: FY2028 sewer projection STILL scores 0 after the tick", () => {
  withFrozenClock("2027-07-01T00:00:00Z", () => {
    assertEqual(
      score(SEWER_Q, "sewer_fy2028_projection"),
      0,
      "corpus-anchored gate must keep the FY2028 projection at 0 regardless of the clock",
    );
  });
});

Deno.test("time-travel 2027-07-01: the FY2028 projection does NOT win after the tick (sewer)", () => {
  withFrozenClock("2027-07-01T00:00:00Z", () => {
    const own = score(SEWER_Q, "sewer_fy2027_own");
    const projection = score(SEWER_Q, "sewer_fy2028_projection");
    assert(own > projection, `own-year must still outrank the projection after the tick, got own=${own} projection=${projection}`);
    assert(own >= 3_000_000, `own-year must still be pinnable after the tick, got ${own}`);
  });
});

Deno.test("time-travel 2027-07-01: base-charge projection ($60.79) also does NOT win", () => {
  withFrozenClock("2027-07-01T00:00:00Z", () => {
    assertEqual(score(BASE_Q, "base_fy2028_projection"), 0, "FY2028 base projection must score 0 after the tick");
    const own = score(BASE_Q, "base_fy2027_own");
    assert(own >= 3_000_000, `FY2027 base own-year must remain pinnable, got ${own}`);
  });
});

// ── end-to-end via the real resolver: TODAY and AFTER THE TICK, $9.88 pins ────
Deno.test("resolver today: pins $9.88, never the $10.78 FY2028 projection", () => {
  const keys = ["sewer_fy2027_own", "sewer_fy2028_projection"];
  const winner = resolveDeterministicCurrentValue(SEWER_Q, keys.map(cand), docsFor(keys));
  assert(winner !== null, "expected a pin today");
  assertEqual(winner!.row.value_actual, 9.88, "must pin $9.88 today, never the FY2028 projection $10.78");
});

Deno.test("resolver time-travel 2027-07-01: STILL pins $9.88, never the FY2028 projection", () => {
  withFrozenClock("2027-07-01T00:00:00Z", () => {
    const keys = ["sewer_fy2027_own", "sewer_fy2028_projection"];
    const winner = resolveDeterministicCurrentValue(SEWER_Q, keys.map(cand), docsFor(keys));
    assert(winner !== null, "expected a pin after the tick — a calendar tick must not erase the current value");
    assertEqual(
      formatBudgetValue(winner!.row.value_actual, winner!.row.unit),
      formatBudgetValue(9.88, "dollars"),
      "after the 2027-07-01 tick the resolver must still pin $9.88, never the $10.78 FY2028 projection",
    );
  });
});
