/**
 * Unit tests for the RRF merge logic and rate-limit helpers in query-pipeline.
 *
 * Run with:  deno test supabase/functions/query-pipeline/rrf_test.ts
 */

// ── Inline the testable logic (no Deno/Supabase runtime deps) ────────────────

const RRF_K = 60;

type ChunkTable =
  | "ordinance_provisions"
  | "vote_tallies"
  | "policy_decisions"
  | "budget_indicators"
  | "narrative_chunks";

const CHUNK_TABLES: ChunkTable[] = [
  "ordinance_provisions",
  "vote_tallies",
  "policy_decisions",
  "budget_indicators",
  "narrative_chunks",
];

interface RankedCandidate {
  key: string;
  table: ChunkTable;
  id: string;
  row: Record<string, unknown>;
  rankBm25: number | null;
  rankVector: number | null;
  rrfScore: number;
}

function rrfMerge(
  bm25Results: Map<ChunkTable, Record<string, unknown>[]>,
  vectorResults: Map<ChunkTable, Record<string, unknown>[]>,
): RankedCandidate[] {
  const map = new Map<string, RankedCandidate>();

  for (const table of CHUNK_TABLES) {
    const rows = bm25Results.get(table) ?? [];
    rows.forEach((row, idx) => {
      const id = row.id as string;
      const key = `${table}:${id}`;
      const existing = map.get(key);
      if (existing) {
        existing.rankBm25 = idx + 1;
      } else {
        map.set(key, { key, table, id, row, rankBm25: idx + 1, rankVector: null, rrfScore: 0 });
      }
    });
  }

  for (const table of CHUNK_TABLES) {
    const rows = vectorResults.get(table) ?? [];
    rows.forEach((row, idx) => {
      const id = row.id as string;
      const key = `${table}:${id}`;
      const existing = map.get(key);
      if (existing) {
        existing.rankVector = idx + 1;
      } else {
        map.set(key, { key, table, id, row, rankBm25: null, rankVector: idx + 1, rrfScore: 0 });
      }
    });
  }

  for (const c of map.values()) {
    c.rrfScore =
      (c.rankBm25 !== null ? 1 / (RRF_K + c.rankBm25) : 0) +
      (c.rankVector !== null ? 1 / (RRF_K + c.rankVector) : 0);
  }

  return Array.from(map.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}

function minuteFloor(d: Date): string {
  const out = new Date(d);
  out.setUTCSeconds(0, 0);
  return out.toISOString();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

Deno.test("minuteFloor zeroes seconds and milliseconds", () => {
  const d = new Date("2026-06-22T04:31:47.123Z");
  const result = minuteFloor(d);
  if (result !== "2026-06-22T04:31:00.000Z") {
    throw new Error(`expected 2026-06-22T04:31:00.000Z, got ${result}`);
  }
});

Deno.test("RRF dedup key is table-qualified, not bare id", () => {
  const uuid = "00000000-0000-0000-0000-000000000001";
  const bm25 = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: uuid, content: "test" }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);
  const vector = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: uuid, content: "test" }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);

  const result = rrfMerge(bm25, vector);
  if (result.length !== 1) {
    throw new Error(`expected 1 candidate after dedup, got ${result.length}`);
  }
  if (result[0].key !== `ordinance_provisions:${uuid}`) {
    throw new Error(`expected table-qualified key, got ${result[0].key}`);
  }
});

Deno.test("RRF formula: both legs present — 1/(60+rank_bm25) + 1/(60+rank_vector)", () => {
  const uuid = "00000000-0000-0000-0000-000000000001";
  const bm25 = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: uuid }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);
  const vector = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: uuid }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);

  const result = rrfMerge(bm25, vector);
  const expected = 1 / (60 + 1) + 1 / (60 + 1); // rank=1 for both
  const got = result[0].rrfScore;
  if (Math.abs(got - expected) > 1e-12) {
    throw new Error(`RRF score mismatch: expected ${expected}, got ${got}`);
  }
});

Deno.test("RRF formula: only BM25 leg — missing vector contributes 0", () => {
  const uuid = "00000000-0000-0000-0000-000000000001";
  const bm25 = new Map<ChunkTable, Record<string, unknown>[]>([
    ["vote_tallies", [{ id: uuid }]],
    ["ordinance_provisions", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);
  const vector = new Map<ChunkTable, Record<string, unknown>[]>([
    ["vote_tallies", []],
    ["ordinance_provisions", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);

  const result = rrfMerge(bm25, vector);
  const expected = 1 / (60 + 1); // only BM25 leg
  const got = result[0].rrfScore;
  if (Math.abs(got - expected) > 1e-12) {
    throw new Error(`RRF score mismatch: expected ${expected}, got ${got}`);
  }
  if (result[0].rankVector !== null) {
    throw new Error("rankVector should be null when absent from vector leg");
  }
});

Deno.test("RRF sorts by score descending", () => {
  const id1 = "00000000-0000-0000-0000-000000000001";
  const id2 = "00000000-0000-0000-0000-000000000002";
  // id1: rank1 in BM25, rank1 in vector → highest score
  // id2: rank2 in BM25, rank2 in vector → lower score
  const bm25 = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: id1 }, { id: id2 }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);
  const vector = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: id1 }, { id: id2 }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);

  const result = rrfMerge(bm25, vector);
  if (result[0].id !== id1) {
    throw new Error(`expected id1 first (rank 1 in both legs), got ${result[0].id}`);
  }
  if (result[0].rrfScore <= result[1].rrfScore) {
    throw new Error("result not sorted descending by rrfScore");
  }
});

Deno.test("RRF cross-table dedup: same UUID in different tables are distinct keys", () => {
  const sameUuid = "00000000-0000-0000-0000-000000000001";
  const bm25 = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: sameUuid }]],
    ["vote_tallies", [{ id: sameUuid }]], // same UUID, different table
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);
  const vector = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", []],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);

  const result = rrfMerge(bm25, vector);
  // Same UUID across two tables = two distinct candidates (table-qualified keys differ)
  if (result.length !== 2) {
    throw new Error(`expected 2 candidates (cross-table same UUID), got ${result.length}`);
  }
  const keys = result.map((c) => c.key).sort();
  if (!keys.includes(`ordinance_provisions:${sameUuid}`)) {
    throw new Error("missing ordinance_provisions key");
  }
  if (!keys.includes(`vote_tallies:${sameUuid}`)) {
    throw new Error("missing vote_tallies key");
  }
});

Deno.test("RRF empty results → empty candidates array", () => {
  const empty = new Map<ChunkTable, Record<string, unknown>[]>(
    CHUNK_TABLES.map((t) => [t, []]),
  );
  const result = rrfMerge(empty, empty);
  if (result.length !== 0) {
    throw new Error(`expected 0 candidates, got ${result.length}`);
  }
});
