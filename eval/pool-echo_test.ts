/**
 * Unit tests for the pool-echo aggregation logic (eval/pool-echo.ts).
 *
 * These import the REAL shipping functions `goldRankInRows` and
 * `summarizePoolEcho` — not a re-implementation — and exercise them against
 * fixtures built from LIVE-VERIFIED ranks (see the PR's spot-check section):
 *   • retrieval-001 gold 019f34cc… sits at BM25 in-table rank 14 in
 *     ordinance_provisions (verified against the live DB).
 *   • the CH45 stub gold 750acf56… ('(Repealed by 44-86-45.)', 23 chars) is
 *     effectively unreachable by either arm.
 *
 * Run with:  deno test eval/pool-echo_test.ts
 *
 * Local assert helpers (matching the repo's other _test.ts files) keep this test
 * hermetic — no std/network imports, no DB.
 */

import {
  goldRankInRows,
  type PoolChunkTable,
  type PoolRow,
  summarizePoolEcho,
} from "./pool-echo.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEquals<T>(actual: T, expected: T, message?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message ?? "assertEquals"}: got ${a}, expected ${e}`);
  }
}

const RETRIEVAL_001_GOLD = "019f34cc-7827-7691-a5ee-13b506ecf41d";
const CH45_GOLD = "750acf56-9946-4a9b-b7e2-d83f7cd15a50";

/** Build an ordinance_provisions BM25 result of `n` rows with `gold` at 1-based
 *  position `rank` (rest are filler ids), mirroring what the RPC returns. */
function ordinanceArm(
  gold: string,
  rank: number,
  n = 40,
  prefix = "ord",
): PoolRow[] {
  const rows: PoolRow[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push({ id: i === rank ? gold : `filler-${prefix}-${i}` });
  }
  return rows;
}

function tableMap(
  entries: Array<[PoolChunkTable, PoolRow[]]>,
): Map<PoolChunkTable, PoolRow[]> {
  return new Map(entries);
}

// ── goldRankInRows ────────────────────────────────────────────────────────────

Deno.test("goldRankInRows returns the 1-based position of the first gold", () => {
  const rows = ordinanceArm(RETRIEVAL_001_GOLD, 14);
  assertEquals(
    goldRankInRows(rows, new Set([RETRIEVAL_001_GOLD])),
    14,
    "gold at index 13 must report rank 14 (1-based)",
  );
});

Deno.test("goldRankInRows returns null when no gold id is present", () => {
  const rows = ordinanceArm("filler", 999); // gold never placed
  assertEquals(
    goldRankInRows(rows, new Set([CH45_GOLD])),
    null,
    "absent gold must be null, not a rank",
  );
});

Deno.test("goldRankInRows takes the FIRST matching gold when several are present", () => {
  const rows: PoolRow[] = [
    { id: "a" },
    { id: "goldB" },
    { id: "goldA" },
  ];
  assertEquals(goldRankInRows(rows, new Set(["goldA", "goldB"])), 2);
});

// ── summarizePoolEcho ─────────────────────────────────────────────────────────

Deno.test("summarize: BM25-only hit (retrieval-001 shape) — surfaced, downstream-drop candidate", () => {
  const bm25 = tableMap([
    ["ordinance_provisions", ordinanceArm(RETRIEVAL_001_GOLD, 14)],
  ]);
  const vector = tableMap([
    // 40 rows, gold absent, disjoint filler namespace from the BM25 arm.
    ["ordinance_provisions", ordinanceArm("nope", 999, 40, "vec")],
  ]);
  const echo = summarizePoolEcho([RETRIEVAL_001_GOLD], bm25, vector);

  assertEquals(echo.gold_in_pool, true, "gold present in BM25 ⇒ in pool");
  assertEquals(echo.gold_rank_bm25, 14, "BM25 in-table rank must be 14");
  assertEquals(echo.gold_rank_vector, null, "gold absent from vector arm");
  // BM25 arm: 39 filler-ord + gold = 40 distinct; vector arm: 40 filler-vec
  // distinct; no overlap ⇒ 80 distinct {table}:{id}.
  assertEquals(echo.pool_size, 80, "merged pool = distinct {table}:{id}");
  assertEquals(echo.gold_detail.length, 1);
  assertEquals(echo.gold_detail[0].table, "ordinance_provisions");
  assertEquals(echo.gold_detail[0].rank_bm25, 14);
});

Deno.test("summarize: CH45 stub — unreachable by either arm is RETRIEVAL-BLIND", () => {
  // The stub is never returned by either arm.
  const bm25 = tableMap([
    ["ordinance_provisions", ordinanceArm("other", 999)],
  ]);
  const vector = tableMap([
    ["ordinance_provisions", ordinanceArm("other2", 999)],
  ]);
  const echo = summarizePoolEcho([CH45_GOLD], bm25, vector);

  assertEquals(echo.gold_in_pool, false, "never surfaced ⇒ NOT in pool");
  assertEquals(echo.gold_rank_bm25, null);
  assertEquals(echo.gold_rank_vector, null);
  assertEquals(echo.gold_detail[0].table, null, "gold found in no table");
});

Deno.test("summarize: vector-only hit still counts as surfaced", () => {
  const bm25 = tableMap([["narrative_chunks", []]]);
  const vector = tableMap([
    ["narrative_chunks", [{ id: "x" }, { id: "GOLDV" }, { id: "y" }]],
  ]);
  const echo = summarizePoolEcho(["GOLDV"], bm25, vector);
  assertEquals(echo.gold_in_pool, true, "vector arm surfaced it");
  assertEquals(echo.gold_rank_bm25, null);
  assertEquals(echo.gold_rank_vector, 2);
});

Deno.test("summarize: pool_size dedups a chunk that appears in BOTH arms", () => {
  const shared = { id: "SHARED" };
  const bm25 = tableMap([["policy_decisions", [shared, { id: "a" }]]]);
  const vector = tableMap([["policy_decisions", [shared, { id: "b" }]]]);
  const echo = summarizePoolEcho([], bm25, vector);
  // policy_decisions:SHARED (once), :a, :b  = 3 distinct.
  assertEquals(echo.pool_size, 3, "same {table}:{id} counted once across arms");
  assertEquals(echo.gold_in_pool, false, "no gold ids ⇒ not in pool");
});

Deno.test("summarize: multiple golds report the BEST (lowest) per-arm rank", () => {
  const bm25 = tableMap([
    ["ordinance_provisions", [{ id: "g-lo" }, { id: "z" }, { id: "g-hi" }]],
  ]);
  const vector = tableMap([["ordinance_provisions", []]]);
  const echo = summarizePoolEcho(["g-hi", "g-lo"], bm25, vector);
  assertEquals(echo.gold_rank_bm25, 1, "min rank across golds (g-lo at 1)");
});

Deno.test("summarize: vector_arm_error is recorded and vector rank stays null", () => {
  const bm25 = tableMap([
    ["ordinance_provisions", ordinanceArm(RETRIEVAL_001_GOLD, 3)],
  ]);
  const vector = tableMap([]); // vector arm produced nothing
  const echo = summarizePoolEcho([RETRIEVAL_001_GOLD], bm25, vector, {
    vectorArmError: "embed endpoint unreachable",
  });
  assertEquals(echo.vector_arm_error, "embed endpoint unreachable");
  assertEquals(echo.gold_rank_vector, null);
  // BM25 still gives a lower-bound gold_in_pool=true — a degraded run is not
  // silently read as "vector missed it".
  assertEquals(echo.gold_in_pool, true);
});

Deno.test("summarize: arm_errors are recorded when a table RPC degraded", () => {
  const bm25 = tableMap([
    ["ordinance_provisions", ordinanceArm(RETRIEVAL_001_GOLD, 5)],
  ]);
  const vector = tableMap([["ordinance_provisions", []]]);
  const echo = summarizePoolEcho([RETRIEVAL_001_GOLD], bm25, vector, {
    armErrors: ["bm25_budget_indicators: canceling statement due to statement timeout"],
  });
  assertEquals(echo.arm_errors?.length, 1);
  assert(
    echo.arm_errors![0].includes("bm25_budget_indicators"),
    "arm error label preserved",
  );
  // A degraded non-home table must not disturb the gold's own-table rank.
  assertEquals(echo.gold_rank_bm25, 5);
});
