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
  ancestors: Array<
    { municode_node_id: string; title: string; node_depth: number }
  >;
  municode_node_id: string | undefined;
  superseded_date: string | null;
  hasAmendmentHistory: boolean;
}

interface SourceDocument {
  id: string;
  url: string;
  title: string | null;
  filename: string | null;
  ingested_at: string;
  source_published_at: string | null;
  fiscal_year: number | null;
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
        map.set(key, {
          key,
          table,
          id,
          row,
          rankBm25: idx + 1,
          rankVector: null,
          rrfScore: 0,
        });
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
        map.set(key, {
          key,
          table,
          id,
          row,
          rankBm25: null,
          rankVector: idx + 1,
          rrfScore: 0,
        });
      }
    });
  }

  for (const c of map.values()) {
    c.rrfScore = (c.rankBm25 !== null ? 1 / (RRF_K + c.rankBm25) : 0) +
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

function isHistoricalQuery(query: string): boolean {
  return /\b(19|20)\d{2}\b/.test(query) ||
    /\b(as of|at the time of|before the|prior to|in january|in february|in march|in april|in may|in june|in july|in august|in september|in october|in november|in december)\b/i
      .test(query);
}

function isCurrentStateQuery(query: string): boolean {
  if (isHistoricalQuery(query)) return false;
  return /\b(current|currently|now|today|present|latest|this year|current rate|tax rate)\b/i
    .test(query);
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function candidateText(c: EnrichedCandidate): string {
  if (c.table === "budget_indicators") {
    return [
      c.row.raw_extracted_text,
      c.row.fiscal_year,
      c.row.program,
      c.row.indicator_name,
      c.row.value_actual,
      c.row.unit,
    ].map((value) => value === null || value === undefined ? "" : String(value))
      .join(" ");
  }
  if (c.table === "narrative_chunks") return normalizedText(c.row.content);
  return "";
}

function candidateCorpus(c: EnrichedCandidate, doc?: SourceDocument): string {
  return [
    candidateText(c),
    c.row.program,
    c.row.indicator_name,
    c.row.department,
    doc?.title,
    doc?.filename,
    doc?.url,
  ].map(normalizedText).join(" ");
}

function mentionsRealEstateTax(query: string): boolean {
  return /\b(real estate|property)\b/i.test(query) && /\btax\b/i.test(query);
}

function isRelevantTaxRateCandidate(
  query: string,
  c: EnrichedCandidate,
  doc?: SourceDocument,
): boolean {
  if (!/\btax\b/i.test(query) || !/\brate\b/i.test(query)) return false;
  const corpus = candidateCorpus(c, doc);
  if (mentionsRealEstateTax(query)) {
    return /\b(real estate|property)\b/.test(corpus) && /\btax\b/.test(corpus);
  }
  return /\btax\b/.test(corpus) && /\brate\b/.test(corpus);
}

function isAdoptedBudgetSource(
  c: EnrichedCandidate,
  doc?: SourceDocument,
): boolean {
  const corpus = candidateCorpus(c, doc);
  return /\badopt(ed|ion)?\b/.test(corpus) &&
    !/\b(proposed|advertised|mark[- ]?up|markup|draft)\b/.test(corpus);
}

function parseDocumentDate(doc?: SourceDocument): number | null {
  if (!doc) return null;
  if (doc.source_published_at) {
    const parsed = Date.parse(doc.source_published_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const text = [doc.title, doc.filename, doc.url].filter(Boolean).join(" ");
  const named = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+([0-3]?\d),?\s+(20\d{2})\b/i,
  );
  if (named) {
    const parsed = Date.parse(`${named[1]} ${named[2]}, ${named[3]}`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function currentStateScore(
  query: string,
  c: EnrichedCandidate,
  doc?: SourceDocument,
): number {
  if (
    c.table === "budget_indicators" && isRelevantTaxRateCandidate(query, c, doc)
  ) {
    const fiscalYear = asNumber(c.row.fiscal_year) ?? doc?.fiscal_year ?? 0;
    const adoptedBoost = isAdoptedBudgetSource(c, doc) ? 100 : 0;
    const draftPenalty =
      /\b(proposed|advertised|mark[- ]?up|markup|draft)\b/.test(
          candidateCorpus(c, doc),
        )
        ? -100
        : 0;
    return 1000 + adoptedBoost + draftPenalty + fiscalYear;
  }

  if (
    c.table === "narrative_chunks" && isRelevantTaxRateCandidate(query, c, doc)
  ) {
    const docDate = parseDocumentDate(doc);
    const adoptedBoost = isAdoptedBudgetSource(c, doc) ? 100 : 0;
    const draftPenalty =
      /\b(proposed|advertised|mark[- ]?up|markup|draft)\b/.test(
          candidateCorpus(c, doc),
        )
        ? -100
        : 0;
    return 500 + adoptedBoost + draftPenalty +
      (docDate === null ? 0 : docDate / 86_400_000);
  }

  return 0;
}

function rerankCurrentStateCandidatesForTest(
  query: string,
  candidates: EnrichedCandidate[],
  documents: Map<string, SourceDocument>,
): EnrichedCandidate[] {
  if (!isCurrentStateQuery(query)) return candidates;
  return [...candidates].sort((a, b) => {
    const docA = typeof a.row.document_id === "string"
      ? documents.get(a.row.document_id)
      : undefined;
    const docB = typeof b.row.document_id === "string"
      ? documents.get(b.row.document_id)
      : undefined;
    const scoreDelta = currentStateScore(query, b, docB) -
      currentStateScore(query, a, docA);
    if (scoreDelta !== 0) return scoreDelta;
    return b.rrfScore - a.rrfScore;
  });
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
  const seenKeys = new Set(candidates.map((c) => c.key));
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
  return candidates.filter((c) => c.table === "ordinance_provisions").length;
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
    amendmentCaveat: appendCaveat(
      amendmentCaveat,
      VERSION_HISTORY_INCOMPLETE_CAVEAT,
    ),
  };
}

interface CitationMapEntry {
  chunk_id: string;
  page: number | null;
  bbox: unknown | null;
}

interface CitationChunk {
  chunk_id: string;
  source_url: string;
  source_title: string;
  page_number: number | null;
  bbox: unknown | null;
  retrieved_at: string | null;
  formatted: string;
  rank: number;
}

interface AnswerDraftResult {
  answer: string;
  citations: CitationChunk[];
  citationMap: Record<string, CitationMapEntry>;
  chunkText: Record<string, string>;
}

interface LlmCallBudget {
  used: number;
  cap: number;
}

const UNVERIFIED_CAVEAT =
  "Caveat: This answer could not be fully verified against the cited source text.";

function testDraft(claims: string[]): AnswerDraftResult {
  const citationMap: Record<string, CitationMapEntry> = {};
  for (const claim of claims) {
    citationMap[claim] = {
      chunk_id: "00000000-0000-0000-0000-000000000099",
      page: null,
      bbox: null,
    };
  }
  return {
    answer: claims.join(" ") ||
      "not in the documents [chunk_id=00000000-0000-0000-0000-000000000099; page=null; bbox=null]",
    citations: [],
    citationMap,
    chunkText: { "00000000-0000-0000-0000-000000000099": "source text" },
  };
}

function textHasNumber(text: string): boolean {
  return /\b\d+(?:[,\d]*\d)?(?:\.\d+)?%?\b/.test(text);
}

function draftHasNumericClaim(draft: AnswerDraftResult): boolean {
  const claims = Object.keys(draft.citationMap);
  if (claims.length > 0) return claims.some(textHasNumber);

  const withoutUuidCitations = draft.answer.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "",
  );
  return textHasNumber(withoutUuidCitations);
}

function shouldRunVerifier(
  draft: AnswerDraftResult,
  temporalFlag: boolean,
): boolean {
  return temporalFlag || draftHasNumericClaim(draft);
}

function hasRemainingLlmCall(budget: LlmCallBudget): boolean {
  return budget.used < budget.cap;
}

function consumeLlmCall(budget: LlmCallBudget): boolean {
  if (!hasRemainingLlmCall(budget)) return false;
  budget.used += 1;
  return true;
}

function withUnverifiedCaveat(draft: AnswerDraftResult): AnswerDraftResult {
  if (draft.answer.includes(UNVERIFIED_CAVEAT)) return draft;
  return {
    ...draft,
    answer: `${draft.answer.trim()}\n\n${UNVERIFIED_CAVEAT}`,
  };
}

function retrievedDate(ingestedAt: string | null): string {
  if (!ingestedAt) return "retrieval date unavailable";
  const parsed = new Date(ingestedAt);
  if (Number.isNaN(parsed.getTime())) return "retrieval date unavailable";
  return parsed.toISOString().slice(0, 10);
}

function formatCitation(
  title: string,
  page: number | null,
  ingestedAt: string | null,
): string {
  const pageText = page === null ? "page n/a" : `page ${page}`;
  return `[${title}, ${pageText}, retrieved ${retrievedDate(ingestedAt)}]`;
}

// ── Source title resolution (mirrors index.ts's sourceTitle) ─────────────────

interface SourceDocument {
  id: string;
  url: string;
  title: string | null;
  filename: string | null;
  ingested_at: string;
  doc_type: string | null;
  source_published_at: string | null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  bos_summary: "Board Summary",
  bos_minutes: "Board Minutes",
  budget_pdf: "Budget Document",
  municode_api: "Municode Ordinance",
  encode_zoning: "Zoning Ordinance",
};

const CHUNK_TABLE_LABELS: Record<ChunkTable, string> = {
  ordinance_provisions: "Ordinance Provision",
  vote_tallies: "Vote Tally",
  policy_decisions: "Policy Decision",
  budget_indicators: "Budget Indicator",
  narrative_chunks: "Document",
};

function fallbackSourceDate(doc: SourceDocument | undefined): string | null {
  if (!doc) return null;
  const raw = doc.source_published_at ?? doc.ingested_at;
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function sourceTitle(
  doc: SourceDocument | undefined,
  c: EnrichedCandidate,
): string {
  if (doc?.title) return doc.title;
  if (doc?.filename) return doc.filename;
  if (c.table === "ordinance_provisions") {
    const provisionTitle = asText(c.row.section_title) ??
      asText(c.row.municode_node_id);
    if (provisionTitle) return provisionTitle;
  }

  const label = (doc?.doc_type && DOC_TYPE_LABELS[doc.doc_type]) ??
    CHUNK_TABLE_LABELS[c.table];
  const date = fallbackSourceDate(doc);
  return date ? `${label} — ${date}` : label;
}

function validIsoTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function mostRecentRetrievedAt(citations: CitationChunk[]): string | null {
  let latestMs = -Infinity;
  let latestIso: string | null = null;

  for (const citation of citations) {
    const iso = validIsoTimestamp(citation.retrieved_at);
    if (!iso) continue;
    const ms = new Date(iso).getTime();
    if (ms > latestMs) {
      latestMs = ms;
      latestIso = iso;
    }
  }

  return latestIso;
}

function freshnessNotice(freshnessTimestamp: string | null): string | null {
  if (!freshnessTimestamp) return null;
  return `Sources current as of ${retrievedDate(freshnessTimestamp)}`;
}

function citationByChunkId(citations: CitationChunk[]): Map<string, string> {
  return new Map(citations.map((citation) => [
    citation.chunk_id,
    citation.formatted,
  ]));
}

function formatInlineAnswerCitations(
  answer: string,
  citations: CitationChunk[],
): string {
  const labels = citationByChunkId(citations);
  return answer.replace(
    /\[chunk_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12});[^\n]*?\](?:\])?/gi,
    (raw, chunkId: string) => labels.get(chunkId) ?? raw,
  );
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
    throw new Error(
      `expected id1 first (rank 1 in both legs), got ${result[0].id}`,
    );
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
    throw new Error(
      `expected 2 candidates (cross-table same UUID), got ${result.length}`,
    );
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
    testCandidate("vote_tallies", originalId, {
      reconsidered_by: reconsideredBy,
    }),
  ];

  const result = appendFetchedFkRows(
    context,
    [{ id: reconsideredBy, motion_text: "reconsidered motion" }],
    [],
  );

  if (result.length !== 2) {
    throw new Error(
      `expected linked vote row to be appended, got ${result.length} rows`,
    );
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
    testCandidate("policy_decisions", amendmentId, {
      amends_decision_id: originalId,
    }),
  ];

  const result = appendFetchedFkRows(
    context,
    [],
    [{ id: originalId, subject: "original budget adoption" }],
  );

  if (result.length !== 2) {
    throw new Error(
      `expected linked decision row to be appended, got ${result.length} rows`,
    );
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
    throw new Error(
      `expected no duplicate linked row, got ${result.length} rows`,
    );
  }
});

Deno.test("completeness check flags temporal context with fewer than two version chunks", () => {
  const context = [
    testCandidate(
      "ordinance_provisions",
      "00000000-0000-0000-0000-000000000040",
    ),
    testCandidate("vote_tallies", "00000000-0000-0000-0000-000000000041"),
  ];

  const result = applyCompletenessCheck(context, true, "Existing caveat.");

  if (!result.incompleteSearchWarning) {
    throw new Error("expected incompleteSearchWarning=true");
  }
  if (
    result.amendmentCaveat !==
      "Existing caveat. Version history may be incomplete"
  ) {
    throw new Error(`unexpected caveat: ${result.amendmentCaveat}`);
  }
});

Deno.test("completeness check passes temporal context with at least two version chunks", () => {
  const context = [
    testCandidate(
      "ordinance_provisions",
      "00000000-0000-0000-0000-000000000050",
    ),
    testCandidate(
      "ordinance_provisions",
      "00000000-0000-0000-0000-000000000051",
    ),
  ];

  const result = applyCompletenessCheck(context, true, null);

  if (result.incompleteSearchWarning) {
    throw new Error("expected incompleteSearchWarning=false");
  }
  if (result.amendmentCaveat !== null) {
    throw new Error(`expected null caveat, got ${result.amendmentCaveat}`);
  }
});

Deno.test("verifier trigger: numeric cited claim runs verifier", () => {
  const draft = testDraft(["The fee is 25 dollars"]);

  if (!shouldRunVerifier(draft, false)) {
    throw new Error("expected numeric claim to trigger verifier");
  }
});

Deno.test("verifier trigger: temporal flag runs verifier without numeric claim", () => {
  const draft = testDraft(["The ordinance is current"]);

  if (!shouldRunVerifier(draft, true)) {
    throw new Error("expected temporal_flag=true to trigger verifier");
  }
});

Deno.test("verifier trigger: nonnumeric non-temporal draft skips verifier", () => {
  const draft = testDraft(["The ordinance applies to residential permits"]);

  if (shouldRunVerifier(draft, false)) {
    throw new Error("expected nonnumeric non-temporal draft to skip verifier");
  }
});

Deno.test("verifier trigger ignores UUID-only citation numbers when no claim map exists", () => {
  const draft = testDraft([]);

  if (shouldRunVerifier(draft, false)) {
    throw new Error(
      "expected UUID citation numbers alone not to trigger verifier",
    );
  }
});

Deno.test("verifier correction budget caps post-draft calls and falls back with caveat", () => {
  const budget = { used: 2, cap: 5 };

  if (!consumeLlmCall(budget)) throw new Error("expected verifier call budget");
  if (!consumeLlmCall(budget)) {
    throw new Error("expected first correction call budget");
  }
  if (!consumeLlmCall(budget)) {
    throw new Error("expected second correction call budget");
  }
  if (consumeLlmCall(budget)) {
    throw new Error("must not allow a sixth total LLM call");
  }
  if (budget.used !== 5) throw new Error(`expected used=5, got ${budget.used}`);

  const caveated = withUnverifiedCaveat(testDraft(["The fee is 25 dollars"]));
  if (!caveated.answer.includes(UNVERIFIED_CAVEAT)) {
    throw new Error(
      "expected unverified caveat after exhausted correction passes",
    );
  }
});

Deno.test("sourceTitle prefers the document's real title when populated", () => {
  const doc: SourceDocument = {
    id: "d1",
    url: "https://example.test/doc.pdf",
    title: "FY 2026 Adopted Budget",
    filename: null,
    ingested_at: "2026-06-20T15:30:00Z",
    doc_type: "budget_pdf",
    source_published_at: null,
  };
  const title = sourceTitle(
    doc,
    testCandidate("budget_indicators", "00000000-0000-0000-0000-000000000d01"),
  );
  if (title !== "FY 2026 Adopted Budget") {
    throw new Error(`expected real title, got: ${title}`);
  }
});

Deno.test("sourceTitle falls back to filename when title is missing", () => {
  const doc: SourceDocument = {
    id: "d1",
    url: "https://example.test/doc.pdf",
    title: null,
    filename: "budget-2026.pdf",
    ingested_at: "2026-06-20T15:30:00Z",
    doc_type: "budget_pdf",
    source_published_at: null,
  };
  const title = sourceTitle(
    doc,
    testCandidate("budget_indicators", "00000000-0000-0000-0000-000000000d01"),
  );
  if (title !== "budget-2026.pdf") {
    throw new Error(`expected filename fallback, got: ${title}`);
  }
});

Deno.test("sourceTitle never surfaces the raw table name when title/filename are both null", () => {
  // Regression test: bos_summary/bos_minutes/budget_pdf documents currently
  // have title=null and filename=null for every ingested row (a real
  // ingestion gap — see PR description) — this previously leaked the raw
  // Postgres table name (e.g. 'narrative_chunks') into user-facing citations.
  const doc: SourceDocument = {
    id: "d1",
    url: "https://example.test/BOS_2026-06-09.pdf",
    title: null,
    filename: null,
    ingested_at: "2026-06-09T12:00:00Z",
    doc_type: "bos_summary",
    source_published_at: null,
  };
  const title = sourceTitle(
    doc,
    testCandidate("narrative_chunks", "00000000-0000-0000-0000-000000000d02"),
  );
  if (title === "narrative_chunks") {
    throw new Error("raw table name leaked into citation title");
  }
  if (title !== "Board Summary — 2026-06-09") {
    throw new Error(`unexpected fallback title: ${title}`);
  }
});

Deno.test("sourceTitle maps every known doc_type to a human-readable label", () => {
  const cases: Array<[string, string]> = [
    ["bos_summary", "Board Summary"],
    ["bos_minutes", "Board Minutes"],
    ["budget_pdf", "Budget Document"],
    ["municode_api", "Municode Ordinance"],
    ["encode_zoning", "Zoning Ordinance"],
  ];
  for (const [docType, label] of cases) {
    const doc: SourceDocument = {
      id: "d1",
      url: "https://example.test/doc",
      title: null,
      filename: null,
      ingested_at: "2026-06-09T12:00:00Z",
      doc_type: docType,
      source_published_at: null,
    };
    const title = sourceTitle(
      doc,
      testCandidate("narrative_chunks", "00000000-0000-0000-0000-000000000d02"),
    );
    if (title !== `${label} — 2026-06-09`) {
      throw new Error(
        `doc_type ${docType}: expected "${label} — 2026-06-09", got "${title}"`,
      );
    }
  }
});

Deno.test("sourceTitle prefers source_published_at over ingested_at when both are present", () => {
  const doc: SourceDocument = {
    id: "d1",
    url: "https://example.test/doc.pdf",
    title: null,
    filename: null,
    ingested_at: "2026-07-15T00:54:03Z",
    doc_type: "bos_summary",
    source_published_at: "1995-08-07",
  };
  const title = sourceTitle(
    doc,
    testCandidate("narrative_chunks", "00000000-0000-0000-0000-000000000d02"),
  );
  if (title !== "Board Summary — 1995-08-07") {
    throw new Error(`expected real document date to win, got: ${title}`);
  }
});

Deno.test("sourceTitle uses section_title for ordinance_provisions before falling back", () => {
  const title = sourceTitle(
    undefined,
    testCandidate(
      "ordinance_provisions",
      "00000000-0000-0000-0000-000000000d03",
      { section_title: "Sect. 8-918" },
    ),
  );
  if (title !== "Sect. 8-918") {
    throw new Error(`expected section_title, got: ${title}`);
  }
});

Deno.test("sourceTitle never surfaces the raw table name when no document row exists at all", () => {
  // Covers a dangling document_id / lookup failure: fetchSourceDocuments()
  // returns an empty map for that id, so doc is undefined here.
  const title = sourceTitle(
    undefined,
    testCandidate("budget_indicators", "00000000-0000-0000-0000-000000000d01"),
  );
  if (title === "budget_indicators") {
    throw new Error("raw table name leaked into citation title");
  }
  if (title !== "Budget Indicator") {
    throw new Error(`unexpected no-document fallback: ${title}`);
  }
});

Deno.test("response assembly formats citation labels with title page and retrieved date", () => {
  const formatted = formatCitation(
    "FY 2026 Adopted Budget",
    42,
    "2026-06-20T15:30:00Z",
  );

  if (formatted !== "[FY 2026 Adopted Budget, page 42, retrieved 2026-06-20]") {
    throw new Error(`unexpected formatted citation: ${formatted}`);
  }
});

Deno.test("response assembly replaces inline chunk-id citations with formatted citations", () => {
  const chunkId = "00000000-0000-0000-0000-000000000099";
  const citations: CitationChunk[] = [{
    chunk_id: chunkId,
    source_url: "https://example.test/budget.pdf",
    source_title: "FY 2026 Adopted Budget",
    page_number: 42,
    bbox: null,
    retrieved_at: "2026-06-20T15:30:00Z",
    formatted: "[FY 2026 Adopted Budget, page 42, retrieved 2026-06-20]",
    rank: 1,
  }];

  const answer =
    `The tax rate is 1.12. [chunk_id=${chunkId}; page=42; bbox=null]`;
  const formatted = formatInlineAnswerCitations(answer, citations);

  if (formatted.includes("chunk_id=")) {
    throw new Error(
      `expected internal chunk citation to be removed: ${formatted}`,
    );
  }
  if (
    !formatted.includes(
      "[FY 2026 Adopted Budget, page 42, retrieved 2026-06-20]",
    )
  ) {
    throw new Error(`expected formatted citation in answer: ${formatted}`);
  }
});

Deno.test("response assembly freshness uses most recent cited ingested_at", () => {
  const citations: CitationChunk[] = [
    {
      chunk_id: "00000000-0000-0000-0000-000000000091",
      source_url: "",
      source_title: "Older Source",
      page_number: null,
      bbox: null,
      retrieved_at: "2026-06-18T10:00:00Z",
      formatted: "[Older Source, page n/a, retrieved 2026-06-18]",
      rank: 1,
    },
    {
      chunk_id: "00000000-0000-0000-0000-000000000092",
      source_url: "",
      source_title: "Newer Source",
      page_number: null,
      bbox: null,
      retrieved_at: "2026-06-21T09:00:00Z",
      formatted: "[Newer Source, page n/a, retrieved 2026-06-21]",
      rank: 2,
    },
  ];

  const freshnessTimestamp = mostRecentRetrievedAt(citations);
  if (freshnessTimestamp !== "2026-06-21T09:00:00.000Z") {
    throw new Error(`unexpected freshness timestamp: ${freshnessTimestamp}`);
  }
  if (
    freshnessNotice(freshnessTimestamp) !== "Sources current as of 2026-06-21"
  ) {
    throw new Error("unexpected freshness notice");
  }
});

Deno.test("current-state rerank prefers latest adopted real estate tax budget indicator", () => {
  const markupDocId = "00000000-0000-0000-0000-000000000201";
  const adoptedDocId = "00000000-0000-0000-0000-000000000202";
  const oldMarkup = testCandidate("budget_indicators", "old-markup", {
    document_id: markupDocId,
    fiscal_year: 2025,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.125,
    unit: "dollars per $100 assessed value",
    raw_extracted_text:
      "FY 2025 Budget Mark-Up proposes a Real Estate tax rate of $1.125 per $100.",
  });
  oldMarkup.rrfScore = 0.03;

  const currentAdopted = testCandidate("budget_indicators", "fy2027-adopted", {
    document_id: adoptedDocId,
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.12,
    unit: "dollars per $100 assessed value",
    raw_extracted_text:
      "FY 2027 Adopted Budget sets the Real Estate tax rate at $1.12 per $100.",
  });
  currentAdopted.rrfScore = 0.01;

  const documents = new Map<string, SourceDocument>([
    [markupDocId, {
      id: markupDocId,
      url: "https://example.test/fy2025/markup.pdf",
      title: "FY 2025 Budget Mark-Up",
      filename: "FY2025_Markup.pdf",
      ingested_at: "2026-07-01T00:00:00Z",
      source_published_at: "2024-04-20",
      fiscal_year: 2025,
    }],
    [adoptedDocId, {
      id: adoptedDocId,
      url: "https://example.test/fy2027/adopted/overview.pdf",
      title: "FY 2027 Adopted Budget Overview",
      filename: "FY2027_Adopted_Overview.pdf",
      ingested_at: "2026-07-20T00:00:00Z",
      source_published_at: "2026-05-05",
      fiscal_year: 2027,
    }],
  ]);

  const ranked = rerankCurrentStateCandidatesForTest(
    "what is the current tax rate",
    [oldMarkup, currentAdopted],
    documents,
  );

  if (ranked[0].id !== "fy2027-adopted") {
    throw new Error(`expected FY2027 adopted first, got ${ranked[0].id}`);
  }
});

Deno.test("current-state rerank does not override explicit historical tax-rate queries", () => {
  const oldMarkup = testCandidate("budget_indicators", "old-markup", {
    document_id: "old-doc",
    fiscal_year: 2025,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    raw_extracted_text: "FY 2025 Budget Mark-Up tax rate $1.125.",
  });
  oldMarkup.rrfScore = 0.03;

  const currentAdopted = testCandidate("budget_indicators", "fy2027-adopted", {
    document_id: "new-doc",
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    raw_extracted_text: "FY 2027 Adopted tax rate $1.12.",
  });
  currentAdopted.rrfScore = 0.01;

  const ranked = rerankCurrentStateCandidatesForTest(
    "what was the tax rate in 2024",
    [oldMarkup, currentAdopted],
    new Map(),
  );

  if (ranked[0].id !== "old-markup") {
    throw new Error(
      `expected historical query to preserve retrieval order, got ${
        ranked[0].id
      }`,
    );
  }
});
