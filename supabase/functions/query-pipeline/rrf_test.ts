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

interface EnrichedCandidate extends RankedCandidate {
  ancestors: Array<{ municode_node_id: string; title: string; node_depth: number }>;
  municode_node_id: string | undefined;
  superseded_date: string | null;
  hasAmendmentHistory: boolean;
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

const VERSION_HISTORY_INCOMPLETE_CAVEAT = "Version history may be incomplete";

function testCandidate(
  table: ChunkTable,
  id: string,
  row: Record<string, unknown> = {},
): EnrichedCandidate {
  return {
    key: `${table}:${id}`,
    table,
    id,
    row: { id, ...row },
    rankBm25: 1,
    rankVector: null,
    rrfScore: 1 / (60 + 1),
    ancestors: [],
    municode_node_id: table === "ordinance_provisions" ? id : undefined,
    superseded_date: null,
    hasAmendmentHistory: false,
  };
}

function fkCandidate(
  table: "vote_tallies" | "policy_decisions",
  row: Record<string, unknown>,
): EnrichedCandidate {
  const id = row.id as string;
  return {
    key: `${table}:${id}`,
    table,
    id,
    row,
    rankBm25: null,
    rankVector: null,
    rrfScore: 0,
    ancestors: [],
    municode_node_id: undefined,
    superseded_date: null,
    hasAmendmentHistory: false,
  };
}

function appendFetchedFkRows(
  candidates: EnrichedCandidate[],
  voteRows: Record<string, unknown>[],
  decisionRows: Record<string, unknown>[],
): EnrichedCandidate[] {
  const seenKeys = new Set(candidates.map(c => c.key));
  const appended: EnrichedCandidate[] = [];

  for (const row of voteRows) {
    const linked = fkCandidate("vote_tallies", row);
    if (!seenKeys.has(linked.key)) {
      appended.push(linked);
      seenKeys.add(linked.key);
    }
  }

  for (const row of decisionRows) {
    const linked = fkCandidate("policy_decisions", row);
    if (!seenKeys.has(linked.key)) {
      appended.push(linked);
      seenKeys.add(linked.key);
    }
  }

  return [...candidates, ...appended];
}

function appendCaveat(existing: string | null, caveat: string): string {
  if (existing === null || existing.trim() === "") return caveat;
  if (existing.includes(caveat)) return existing;
  return `${existing} ${caveat}`;
}

function countVersionChunks(candidates: EnrichedCandidate[]): number {
  return candidates.filter(c => c.table === "ordinance_provisions").length;
}

function applyCompletenessCheck(
  candidates: EnrichedCandidate[],
  temporalFlag: boolean,
  amendmentCaveat: string | null,
): { incompleteSearchWarning: boolean; amendmentCaveat: string | null } {
  if (!temporalFlag || countVersionChunks(candidates) >= 2) {
    return { incompleteSearchWarning: false, amendmentCaveat };
  }

  return {
    incompleteSearchWarning: true,
    amendmentCaveat: appendCaveat(amendmentCaveat, VERSION_HISTORY_INCOMPLETE_CAVEAT),
  };
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

Deno.test("FK traversal appends linked reconsideration vote rows after context", () => {
  const originalId = "00000000-0000-0000-0000-000000000010";
  const reconsideredBy = "00000000-0000-0000-0000-000000000011";
  const context = [
    testCandidate("vote_tallies", originalId, { reconsidered_by: reconsideredBy }),
  ];

  const result = appendFetchedFkRows(
    context,
    [{ id: reconsideredBy, motion_text: "reconsidered motion" }],
    [],
  );

  if (result.length !== 2) {
    throw new Error(`expected linked vote row to be appended, got ${result.length} rows`);
  }
  if (result[1].key !== `vote_tallies:${reconsideredBy}`) {
    throw new Error(`expected reconsideration vote key, got ${result[1].key}`);
  }
  if (result[1].rrfScore !== 0) {
    throw new Error("linked FK row should not inherit an RRF score");
  }
});

Deno.test("FK traversal appends linked original policy decision rows after context", () => {
  const amendmentId = "00000000-0000-0000-0000-000000000020";
  const originalId = "00000000-0000-0000-0000-000000000021";
  const context = [
    testCandidate("policy_decisions", amendmentId, { amends_decision_id: originalId }),
  ];

  const result = appendFetchedFkRows(
    context,
    [],
    [{ id: originalId, subject: "original budget adoption" }],
  );

  if (result.length !== 2) {
    throw new Error(`expected linked decision row to be appended, got ${result.length} rows`);
  }
  if (result[1].key !== `policy_decisions:${originalId}`) {
    throw new Error(`expected original decision key, got ${result[1].key}`);
  }
});

Deno.test("FK traversal does not duplicate rows already present in context", () => {
  const originalId = "00000000-0000-0000-0000-000000000030";
  const linkedId = "00000000-0000-0000-0000-000000000031";
  const context = [
    testCandidate("vote_tallies", originalId, { reconsidered_by: linkedId }),
    testCandidate("vote_tallies", linkedId),
  ];

  const result = appendFetchedFkRows(context, [{ id: linkedId }], []);

  if (result.length !== 2) {
    throw new Error(`expected no duplicate linked row, got ${result.length} rows`);
  }
});

Deno.test("completeness check flags temporal context with fewer than two version chunks", () => {
  const context = [
    testCandidate("ordinance_provisions", "00000000-0000-0000-0000-000000000040"),
    testCandidate("vote_tallies", "00000000-0000-0000-0000-000000000041"),
  ];

  const result = applyCompletenessCheck(context, true, "Existing caveat.");

  if (!result.incompleteSearchWarning) {
    throw new Error("expected incompleteSearchWarning=true");
  }
  if (result.amendmentCaveat !== "Existing caveat. Version history may be incomplete") {
    throw new Error(`unexpected caveat: ${result.amendmentCaveat}`);
  }
});

Deno.test("completeness check passes temporal context with at least two version chunks", () => {
  const context = [
    testCandidate("ordinance_provisions", "00000000-0000-0000-0000-000000000050"),
    testCandidate("ordinance_provisions", "00000000-0000-0000-0000-000000000051"),
  ];

  const result = applyCompletenessCheck(context, true, null);

  if (result.incompleteSearchWarning) {
    throw new Error("expected incompleteSearchWarning=false");
  }
  if (result.amendmentCaveat !== null) {
    throw new Error(`expected null caveat, got ${result.amendmentCaveat}`);
  }
});
