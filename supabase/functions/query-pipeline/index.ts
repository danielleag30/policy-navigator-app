/**
 * query-pipeline — Query Pipeline Edge Function (tasks 2-7 through 2-13)
 *
 * Request:  POST  { query: string }
 * Response: SuccessEnvelope<QueryResponseData> | ErrorEnvelope
 *
 * Pipeline steps implemented so far:
 *  1. Rate limit check — 429 if exceeded; increment bucket row for all non-429
 *  2. Embed query via Supabase AI Session (gte-small, 384d)
 *  3. Parallel BM25 + vector retrieval across five chunk-bearing tables (40 each)
 *  4. RRF merge with table-qualified dedup keys: '{table}:{id}'
 *  5. INCOMPLETE_SEARCH_FLOOR gate — return early if max RRF score below floor
 *  6. Ancestor enrichment — hierarchy metadata attached to ordinance chunks (task 2-8)
 *  7. Temporal Judge LLM call — version filtering + temporal flag (task 2-9)
 *  8. Scripted FK traversal — reconsideration/amended-decision rows (task 2-10)
 *  9. Completeness check — temporal answers need sufficient version context (task 2-10)
 * 10. Answer Drafter LLM call — cited draft answer + citation payload (task 2-11)
 * 11. Conditional Verifier LLM call + bounded correction loop (task 2-12)
 * 12. Response assembly + RequestLog persistence (task 2-13)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { corsPreflightResponse, error, success } from "../_shared/response.ts";
import { ollamaChat } from "../_shared/ollama-client.ts";
import { type AiSession } from "../_shared/embedder.ts";
import {
  type CitationChunk,
  type CitationMapEntry,
  type QueryRequest,
  type QueryResponseData,
} from "../_shared/types.ts";
import {
  type DeepHistoricalOutcome,
  type PreingestDb,
  runDeepHistoricalLookup,
  shouldAttemptDeepHistoricalLookup,
} from "./_deep-historical.ts";

declare const Supabase: {
  ai: { Session: new (model: string) => AiSession };
};

// ── Env-var tuning constants ──────────────────────────────────────────────────

const CANDIDATE_COUNT = parseInt(
  Deno.env.get("RETRIEVAL_CANDIDATE_COUNT") ?? "40",
  10,
);

const RRF_K = parseInt(Deno.env.get("RRF_K_CONSTANT") ?? "60", 10);

const INCOMPLETE_SEARCH_FLOOR = parseFloat(
  Deno.env.get("INCOMPLETE_SEARCH_FLOOR") ?? "0.005",
);

const RATE_LIMIT_MAX = parseInt(Deno.env.get("RATE_LIMIT_MAX") ?? "10", 10);

// How many top-RRF candidates to feed the Temporal Judge (default 40 per build plan).
const JUDGE_CONTEXT_COUNT = parseInt(
  Deno.env.get("RETRIEVAL_CONTEXT_COUNT") ?? "40",
  10,
);

// Maximum chunks the Temporal Judge may select (hard ceiling per build plan).
const JUDGE_OUTPUT_LIMIT = 8;

// Temperature for the Temporal Judge — 0.0 for maximum determinism (filter/verifier role).
// Documented in DEPS.md under "Temporal Judge (2-9): 0.0".
const TEMPORAL_JUDGE_TEMPERATURE = 0.0;

// Temperature for the Answer Drafter — prose may vary slightly while staying grounded.
// Documented in _shared/ollama-client.ts under "Answer Drafter (2-11): 0.3".
const ANSWER_DRAFTER_TEMPERATURE = 0.3;

// Temperature for the Verifier and correction passes — deterministic citation checking.
// Documented in _shared/ollama-client.ts under "Verifier (2-12): 0.0".
const VERIFIER_TEMPERATURE = 0.0;

// Build-plan task 2-12 cap: Temporal Judge + Drafter + Verifier + 2 corrections.
const LLM_TOTAL_CALL_CAP = 5;
const MAX_CORRECTION_PASSES = 2;

const VERSION_HISTORY_INCOMPLETE_CAVEAT = "Version history may be incomplete";
const UNVERIFIED_CAVEAT =
  "Caveat: This answer could not be fully verified against the cited source text.";

// ── Chunk-bearing tables ──────────────────────────────────────────────────────

const CHUNK_TABLES = [
  "ordinance_provisions",
  "vote_tallies",
  "policy_decisions",
  "budget_indicators",
  "narrative_chunks",
] as const;

type ChunkTable = (typeof CHUNK_TABLES)[number];

// ── Rate limiting ─────────────────────────────────────────────────────────────

/** Truncate a Date to the start of its UTC minute — the rate limit window key. */
function minuteFloor(d: Date): string {
  const out = new Date(d);
  out.setUTCSeconds(0, 0);
  return out.toISOString();
}

/**
 * Return true if the IP is under the rate limit for the current minute window.
 * Fails open on DB errors to avoid blocking real users.
 */
async function isWithinRateLimit(ip: string): Promise<boolean> {
  const { data, error: dbErr } = await db
    .from("rate_limit_buckets")
    .select("request_count")
    .eq("ip_address", ip)
    .eq("window_start", minuteFloor(new Date()))
    .maybeSingle();

  if (dbErr) {
    console.error("rate-limit read error:", dbErr.message);
    return true; // fail open
  }

  return !data || data.request_count < RATE_LIMIT_MAX;
}

/**
 * Atomically write (first request) or increment (subsequent requests) the
 * rate limit bucket row for this IP/minute-window.  Uses the
 * `increment_rate_limit_bucket` Postgres function added in
 * migration 20260621000001.  Non-fatal on failure.
 */
async function writeBucket(ip: string): Promise<boolean> {
  const { error: dbErr } = await db.rpc("increment_rate_limit_bucket", {
    p_ip_address: ip,
    p_window_start: minuteFloor(new Date()),
    p_id: uuidv7(),
  });
  if (dbErr) {
    console.error("rate-limit bucket write error:", dbErr.message);
    return false;
  }
  return true;
}

// ── BM25 retrieval ────────────────────────────────────────────────────────────

/**
 * Run ts_rank-ordered full-text search against one chunk table.
 * Result ordering (index 0 = highest ts_rank) is the BM25 rank used in RRF.
 */
async function bm25ForTable(
  table: ChunkTable,
  query: string,
): Promise<Record<string, unknown>[]> {
  const { data, error: dbErr } = await db.rpc(`bm25_${table}`, {
    p_query_text: query,
    p_limit: CANDIDATE_COUNT,
  });

  if (dbErr) {
    console.error(`bm25 ${table} error:`, dbErr.message);
    return [];
  }

  return (data ?? []) as Record<string, unknown>[];
}

// ── Vector retrieval ──────────────────────────────────────────────────────────

/**
 * Run cosine-distance-ordered HNSW vector search against one chunk table.
 * Result ordering (index 0 = most similar) is the vector rank used in RRF.
 */
async function vectorForTable(
  table: ChunkTable,
  queryEmbedding: number[],
): Promise<Record<string, unknown>[]> {
  const { data, error: dbErr } = await db.rpc(`match_${table}`, {
    query_embedding: queryEmbedding,
    match_count: CANDIDATE_COUNT,
  });

  if (dbErr) {
    console.error(`vector ${table} error:`, dbErr.message);
    return [];
  }

  return (data ?? []) as Record<string, unknown>[];
}

// ── RRF merge ─────────────────────────────────────────────────────────────────

interface RankedCandidate {
  key: string; // '{table}:{id}' — table-qualified dedup key
  table: ChunkTable;
  id: string;
  row: Record<string, unknown>;
  rankBm25: number | null; // 1-based position in BM25 leg; null if absent
  rankVector: number | null; // 1-based position in vector leg; null if absent
  rrfScore: number; // 1/(K+rank_bm25) + 1/(K+rank_vector), missing leg = 0
}

interface EnrichedCandidate extends RankedCandidate {
  ancestors: Array<
    { municode_node_id: string; title: string; node_depth: number }
  >;
  /** The Municode node identity key for ordinance_provisions chunks; undefined for other tables. */
  municode_node_id: string | undefined;
  /** Computed from peer candidates: effective_date of the current version when this chunk is superseded; null otherwise. */
  superseded_date: string | null;
  /** True when hardFilterSuperseded removed at least one superseded peer for this node — signals amendment history to the judge. */
  hasAmendmentHistory: boolean;
}

interface SourceDocument {
  id: string;
  url: string;
  title: string | null;
  filename: string | null;
  ingested_at: string;
  doc_type: string | null;
  source_published_at: string | null;
  fiscal_year: number | null;
}

interface AnnotatedDrafterChunk {
  chunk_id: string;
  table: ChunkTable;
  rank: number;
  source_url: string;
  source_title: string;
  source_ingested_at: string | null;
  page: number | null;
  bbox: unknown | null;
  text: string;
  metadata: string[];
}

interface AnswerDraftResult {
  answer: string;
  citations: CitationChunk[];
  citationMap: Record<string, CitationMapEntry>;
  chunkText: Record<string, string>;
}

interface FlaggedClaim {
  claim: string;
  chunk_id: string;
  issue: string;
  correction_instruction: string;
}

interface VerifierResult {
  flaggedClaims: FlaggedClaim[];
}

interface CorrectionResult extends AnswerDraftResult {
  flaggedClaims: FlaggedClaim[];
}

interface LlmCallBudget {
  used: number;
  cap: number;
}

interface RequestLogInput {
  ip: string;
  queryText: string;
  responseMs: number;
  chunkCount: number;
  llmCalls: number;
  temporalFlag: boolean;
  verifierFlag: boolean;
  refusal: boolean;
  incompleteSearch: boolean;
}

type FkTraversalResult =
  | { ok: true; candidates: EnrichedCandidate[] }
  | { ok: false; message: string };

/**
 * Merge BM25 and vector result lists using Reciprocal Rank Fusion.
 *
 * Deduplication key: `'{table}:{id}'` — guaranteed never to collide across tables.
 * RRF formula: score = 1/(K + rank_bm25) + 1/(K + rank_vector)
 *   where K = RRF_K (default 60) and ranks are 1-based array positions.
 * Candidates present in only one leg contribute 0 from the missing leg.
 * Returns candidates sorted by rrfScore descending.
 */
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

// ── Ancestor enrichment ───────────────────────────────────────────────────────

/**
 * For each ordinance_provisions candidate, fetch all ancestor nodes via a
 * single batched recursive DB call and attach them as metadata.
 * Ancestors do NOT count toward the 8-chunk ceiling.
 * Non-fatal: if the DB call fails, candidates are returned without ancestors.
 */
async function enrichWithAncestors(
  candidates: RankedCandidate[],
): Promise<EnrichedCandidate[]> {
  const ordinanceCandidates = candidates.filter((c) =>
    c.table === "ordinance_provisions"
  );

  const parentNodeIds = [
    ...new Set(
      ordinanceCandidates
        .map((c) => c.row.parent_node_id as string | null)
        .filter((pid): pid is string => pid !== null),
    ),
  ];

  const ancestorMap = new Map<
    string,
    {
      municode_node_id: string;
      parent_node_id: string | null;
      title: string;
      node_depth: number;
    }
  >();

  if (parentNodeIds.length > 0) {
    const { data, error: ancestorErr } = await db.rpc(
      "get_ordinance_ancestors",
      {
        p_node_ids: parentNodeIds,
      },
    );
    if (ancestorErr) {
      console.error("ancestor lookup error:", ancestorErr.message);
    } else {
      for (const row of (data ?? [])) {
        ancestorMap.set(row.municode_node_id, row);
      }
    }
  }

  // First pass: attach ancestor chains and municode_node_id to each candidate.
  const withAncestors = candidates.map((c) => {
    const nodeId = c.table === "ordinance_provisions"
      ? (c.row.municode_node_id as string | undefined)
      : undefined;

    if (c.table !== "ordinance_provisions") {
      return {
        ...c,
        ancestors: [],
        municode_node_id: undefined,
        superseded_date: null,
        hasAmendmentHistory: false,
      };
    }

    const myParentId = c.row.parent_node_id as string | null;
    if (!myParentId) {
      return {
        ...c,
        ancestors: [],
        municode_node_id: nodeId,
        superseded_date: null,
        hasAmendmentHistory: false,
      };
    }

    const ancestors: Array<
      { municode_node_id: string; title: string; node_depth: number }
    > = [];
    let currentId: string | null = myParentId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const ancestor = ancestorMap.get(currentId);
      if (!ancestor) break;
      ancestors.push({
        municode_node_id: ancestor.municode_node_id,
        title: ancestor.title,
        node_depth: ancestor.node_depth,
      });
      currentId = ancestor.parent_node_id;
    }
    ancestors.sort((a, b) => a.node_depth - b.node_depth);
    return {
      ...c,
      ancestors,
      municode_node_id: nodeId,
      superseded_date: null,
      hasAmendmentHistory: false,
    };
  });

  // Second pass: for is_current=false provisions, derive superseded_date from the
  // effective_date of the current version of the same node if it's in the candidate set.
  const currentVersionDates = new Map<string, string>();
  for (const c of withAncestors) {
    if (
      c.table === "ordinance_provisions" && c.row.is_current === true &&
      c.municode_node_id
    ) {
      const effDate = c.row.effective_date as string | null;
      if (effDate) currentVersionDates.set(c.municode_node_id, effDate);
    }
  }

  return withAncestors.map((c) => {
    if (
      c.table !== "ordinance_provisions" || c.row.is_current === true ||
      !c.municode_node_id
    ) {
      return c;
    }
    const superseded_date = currentVersionDates.get(c.municode_node_id) ?? null;
    return { ...c, superseded_date };
  });
}

// ── Pending code changes ──────────────────────────────────────────────────────

interface PendingChange {
  id: string;
  municode_node_id: string;
  codification_status: string;
  proposed_text: string | null;
}

/**
 * Fetch pending_code_changes rows for any ordinance_provisions municode_node_ids in
 * the candidate set. Non-fatal: returns [] on DB error so the judge proceeds
 * without pending change data rather than failing the request.
 */
async function fetchPendingChanges(
  candidates: EnrichedCandidate[],
): Promise<PendingChange[]> {
  const ordinanceMunicodeIds = candidates
    .filter((c) => c.table === "ordinance_provisions" && c.municode_node_id)
    .map((c) => c.municode_node_id as string);

  const uniqueIds = [...new Set(ordinanceMunicodeIds)];
  if (uniqueIds.length === 0) return [];

  const { data, error: dbErr } = await db
    .from("pending_code_changes")
    .select("id, municode_node_id, codification_status, proposed_text")
    .in("municode_node_id", uniqueIds)
    .eq("codification_status", "pending");

  if (dbErr) {
    console.error("pending changes lookup error:", dbErr.message);
    return [];
  }

  return (data ?? []) as PendingChange[];
}

// ── Hard pre-filter ───────────────────────────────────────────────────────────

/** Heuristic: detect queries that reference a specific past date or time period. */
function isHistoricalQuery(query: string): boolean {
  return /\b(19|20)\d{2}\b/.test(query) ||
    /\b(as of|at the time of|before the|prior to|in january|in february|in march|in april|in may|in june|in july|in august|in september|in october|in november|in december)\b/i
      .test(query);
}

function hasExplicitCurrentIntent(query: string): boolean {
  return /\b(current|currently|now|today|present|latest|this year|current rate)\b/i
    .test(query) ||
    /\b(what(?:'s| is)|show|give|tell)\b[\s\S]*\btax\b[\s\S]*\brate\b/i
      .test(query);
}

function isHistoricalOnlyQuery(query: string): boolean {
  return isHistoricalQuery(query) && !hasExplicitCurrentIntent(query);
}

/**
 * Deterministic pre-filter: for current queries, remove is_current=false ordinance
 * chunks when a same-municode_node_id is_current=true chunk is in the candidate set.
 * For historical queries, skip filtering and let the LLM handle version selection.
 *
 * Returns the filtered list AND the set of municode_node_ids for which at least one
 * superseded chunk was removed — callers use this to tag remaining candidates and
 * force temporalFlag=true without relying solely on the LLM judge.
 */
function hardFilterSuperseded(
  candidates: EnrichedCandidate[],
  historical: boolean,
): { filtered: EnrichedCandidate[]; amendedNodeIds: Set<string> } {
  if (historical) return { filtered: candidates, amendedNodeIds: new Set() };

  const currentNodeIds = new Set(
    candidates
      .filter((c) =>
        c.table === "ordinance_provisions" && c.row.is_current === true
      )
      .map((c) => c.municode_node_id)
      .filter((id): id is string => id !== undefined),
  );

  const amendedNodeIds = new Set<string>();
  const filtered = candidates.filter((c) => {
    if (c.table !== "ordinance_provisions") return true;
    if (c.row.is_current === true) return true;
    const shouldRemove = c.municode_node_id !== undefined &&
      currentNodeIds.has(c.municode_node_id);
    if (shouldRemove && c.municode_node_id) {
      amendedNodeIds.add(c.municode_node_id);
    }
    return !shouldRemove;
  });

  return { filtered, amendedNodeIds };
}

// ── Current-state reranking for non-ordinance evidence ───────────────────────

function isCurrentStateQuery(query: string): boolean {
  return hasExplicitCurrentIntent(query);
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
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

const BUDGET_INDICATOR_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "county",
  "current",
  "currently",
  "different",
  "fairfax",
  "for",
  "in",
  "is",
  "it",
  "latest",
  "now",
  "of",
  "rate",
  "the",
  "this",
  "today",
  "va",
  "value",
  "virginia",
  "was",
  "what",
  "whats",
  "year",
]);

function budgetIndicatorQueryTerms(query: string): string[] {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const terms = normalized.split(/\s+/).filter((term) =>
    term.length > 2 && !BUDGET_INDICATOR_STOPWORDS.has(term) &&
    !/^(19|20)\d{2}$/.test(term)
  );
  return [...new Set(terms)];
}

function matchesBudgetIndicatorQuery(
  query: string,
  c: EnrichedCandidate,
  doc?: SourceDocument,
): boolean {
  const corpus = candidateCorpus(c, doc);
  const terms = budgetIndicatorQueryTerms(query);
  if (terms.length === 0) return true;
  const hasTotSynonym = /\btot\b/.test(corpus) &&
    terms.includes("transient") && terms.includes("occupancy");
  return terms.every((term) =>
    corpus.includes(term) ||
    (hasTotSynonym && (term === "transient" || term === "occupancy"))
  );
}

function isRelevantTaxRateCandidate(
  query: string,
  c: EnrichedCandidate,
  doc?: SourceDocument,
): boolean {
  if (!/\btax\b/i.test(query) || !/\brate\b/i.test(query)) return false;
  const corpus = candidateCorpus(c, doc);
  if (c.table === "budget_indicators") {
    return /\btax\b/.test(corpus) && /\brate\b/.test(corpus) &&
      matchesBudgetIndicatorQuery(query, c, doc);
  }
  if (c.table === "narrative_chunks") {
    return /\btax\b/.test(corpus) && /\brate\b/.test(corpus) &&
      matchesBudgetIndicatorQuery(query, c, doc);
  }
  return /\btax\b/.test(corpus) && /\brate\b/.test(corpus);
}

function isAdoptedBudgetSource(
  c: EnrichedCandidate,
  doc?: SourceDocument,
): boolean {
  const corpus = candidateCorpus(c, doc);
  return /\badopt(ed|ion)?\b/.test(corpus) &&
    !hasDraftQualifierNearRateMention(c) &&
    !hasDraftSourceStatus(doc);
}

function parseDocumentFiscalYear(doc?: SourceDocument): number | null {
  if (!doc) return null;
  const explicitFiscalYear = asNumber(doc.fiscal_year);
  if (explicitFiscalYear !== null) return explicitFiscalYear;

  const text = [doc.url, doc.title, doc.filename].filter(Boolean).join(" ");
  const fiscalYear = text.match(
    /\b(?:fy|fiscal[-_\s]*year[-_\s]*)(20\d{2})\b/i,
  );
  if (fiscalYear) return Number(fiscalYear[1]);

  return null;
}

function parseDocumentRecencyScore(doc?: SourceDocument): number | null {
  if (!doc) return null;
  const fiscalYear = parseDocumentFiscalYear(doc);
  if (fiscalYear !== null) return 1_000_000 + fiscalYear;

  if (doc.source_published_at) {
    const parsed = Date.parse(doc.source_published_at);
    if (!Number.isNaN(parsed)) return parsed / 86_400_000;
  }

  const text = [doc.title, doc.filename, doc.url].filter(Boolean).join(" ");
  const iso = text.match(
    /\b(20\d{2})[-_/](0?[1-9]|1[0-2])[-_/](0?[1-9]|[12]\d|3[01])\b/,
  );
  if (iso) {
    const parsed = Date.parse(
      `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`,
    );
    if (!Number.isNaN(parsed)) return parsed / 86_400_000;
  }

  const named = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+([0-3]?\d),?\s+(20\d{2})\b/i,
  );
  if (named) {
    const parsed = Date.parse(`${named[1]} ${named[2]}, ${named[3]}`);
    if (!Number.isNaN(parsed)) return parsed / 86_400_000;
  }

  if (doc.ingested_at) {
    const parsed = Date.parse(doc.ingested_at);
    if (!Number.isNaN(parsed)) return parsed / 86_400_000;
  }

  return null;
}

function hasDraftQualifierNearRateMention(
  c: EnrichedCandidate,
): boolean {
  const content = candidateText(c);
  const rateMention =
    /\btax\s+rate\b[\s\S]{0,100}(?:\d+(?:\.\d+)?\s*(?:%|percent)|\$\s*\d+(?:\.\d+)?)/ig;
  const valueThenRate =
    /(?:\d+(?:\.\d+)?\s*(?:%|percent)|\$\s*\d+(?:\.\d+)?)[\s\S]{0,100}\btax\s+rate\b/ig;
  const draftRegex = /\b(proposed|advertised|mark[- ]?up|markup|draft)\b/i;
  const windows: string[] = [];

  for (const regex of [rateMention, valueThenRate]) {
    for (const match of content.matchAll(regex)) {
      windows.push(match[0]);
    }
  }

  return windows.some((window) => draftRegex.test(window));
}

function hasDraftSourceStatus(doc?: SourceDocument): boolean {
  const sourceStatus = [doc?.title, doc?.filename, doc?.url]
    .map(normalizedText)
    .join(" ");
  return /\b(proposed|advertised|mark[- ]?up|markup|draft)\b/.test(
    sourceStatus,
  );
}

function hasDraftQualifierForRateEvidence(
  c: EnrichedCandidate,
  doc?: SourceDocument,
): boolean {
  return hasDraftQualifierNearRateMention(c) || hasDraftSourceStatus(doc);
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
    const draftPenalty = hasDraftQualifierForRateEvidence(c, doc) ? -100 : 0;
    return 2_000_000 + adoptedBoost + draftPenalty + fiscalYear;
  }

  if (
    c.table === "narrative_chunks" && isRelevantTaxRateCandidate(query, c, doc)
  ) {
    const recencyScore = parseDocumentRecencyScore(doc);
    const adoptedBoost = isAdoptedBudgetSource(c, doc) ? 100 : 0;
    const draftPenalty = hasDraftQualifierForRateEvidence(c, doc) ? -100 : 0;
    return 500 + adoptedBoost + draftPenalty +
      (recencyScore === null ? 0 : recencyScore);
  }

  return 0;
}

async function rerankCurrentStateCandidates(
  query: string,
  candidates: EnrichedCandidate[],
): Promise<EnrichedCandidate[]> {
  if (!isCurrentStateQuery(query)) return candidates;

  const documents = await fetchSourceDocuments(candidates);
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

function budgetIndicatorCandidate(
  row: Record<string, unknown>,
): EnrichedCandidate {
  const id = row.id as string;
  return {
    key: `budget_indicators:${id}`,
    table: "budget_indicators",
    id,
    row,
    rankBm25: null,
    rankVector: null,
    rrfScore: Number.MAX_SAFE_INTEGER,
    ancestors: [],
    municode_node_id: undefined,
    superseded_date: null,
    hasAmendmentHistory: false,
  };
}

async function fetchCurrentBudgetIndicatorRows(
  query: string,
): Promise<EnrichedCandidate[]> {
  if (
    !isCurrentStateQuery(query) || !/\btax\b/i.test(query) ||
    !/\brate\b/i.test(query)
  ) {
    return [];
  }

  const { data, error: dbErr } = await db
    .from("budget_indicators")
    .select(
      "*, documents!inner(id, url, title, filename, ingested_at, source_published_at, fiscal_year)",
    )
    .or(
      "program.ilike.%Tax%,indicator_name.ilike.%Tax%,raw_extracted_text.ilike.%tax%",
    )
    .not("value_actual", "is", null)
    .order("fiscal_year", { ascending: false })
    .limit(200);

  if (dbErr) {
    console.error(
      "current tax-rate budget indicator lookup error:",
      dbErr.message,
    );
    return [];
  }

  return ((data ?? []) as Record<string, unknown>[])
    .filter((row) => {
      const doc = row.documents as SourceDocument | undefined;
      return isAdoptedBudgetSource(budgetIndicatorCandidate(row), doc) &&
        isRelevantTaxRateCandidate(query, budgetIndicatorCandidate(row), doc);
    })
    .slice(0, 3)
    .map((row) => {
      const { documents: _documents, ...candidateRow } = row;
      return budgetIndicatorCandidate(candidateRow);
    });
}

async function prependCurrentBudgetIndicators(
  query: string,
  candidates: EnrichedCandidate[],
): Promise<EnrichedCandidate[]> {
  const currentIndicators = await fetchCurrentBudgetIndicatorRows(query);
  if (currentIndicators.length === 0) return candidates;

  const seen = new Set(currentIndicators.map((c) => c.key));
  return [
    ...currentIndicators,
    ...candidates.filter((candidate) => !seen.has(candidate.key)),
  ];
}

// ── Temporal Judge ────────────────────────────────────────────────────────────

interface JudgeOutput {
  selected_chunk_ids: string[];
  temporal_flag: boolean;
  amendment_caveat: string | null;
  pending_change_notice: string | null;
  reasoning: string;
}

interface TemporalJudgeResult {
  filteredCandidates: EnrichedCandidate[];
  temporalFlag: boolean;
  amendmentCaveat: string | null;
  pendingChangeNotice: string | null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatUnknown(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pushMetadata(lines: string[], label: string, value: unknown): void {
  if (value !== null && value !== undefined && value !== "") {
    lines.push(`${label}: ${formatUnknown(value)}`);
  }
}

function candidateText(c: EnrichedCandidate): string {
  switch (c.table) {
    case "ordinance_provisions":
      return asText(c.row.content) ?? "";
    case "vote_tallies": {
      const lines: string[] = [];
      pushMetadata(lines, "Motion", c.row.motion_text);
      pushMetadata(lines, "Motion type", c.row.motion_type);
      pushMetadata(lines, "Outcome", c.row.outcome);
      pushMetadata(lines, "Meeting date", c.row.meeting_date);
      const voteParts = [
        `yes ${c.row.vote_yes ?? 0}`,
        `no ${c.row.vote_no ?? 0}`,
        `abstain ${c.row.vote_abstain ?? 0}`,
        `absent ${c.row.vote_absent ?? 0}`,
      ];
      lines.push(`Vote counts: ${voteParts.join(", ")}`);
      pushMetadata(lines, "Individual votes", c.row.individual_votes);
      return lines.join("\n");
    }
    case "policy_decisions": {
      const lines = [asText(c.row.raw_extracted_text)].filter((
        v,
      ): v is string => v !== null);
      pushMetadata(lines, "Subject", c.row.subject);
      pushMetadata(lines, "Decision type", c.row.decision_type);
      pushMetadata(lines, "Meeting date", c.row.meeting_date);
      pushMetadata(lines, "Fiscal year", c.row.fiscal_year);
      pushMetadata(lines, "Amount dollars", c.row.amount_dollars);
      pushMetadata(lines, "Rate value", c.row.rate_value);
      pushMetadata(lines, "Rate unit", c.row.rate_unit);
      pushMetadata(lines, "Effective date", c.row.effective_date);
      return lines.join("\n");
    }
    case "budget_indicators": {
      const lines = [asText(c.row.raw_extracted_text)].filter((
        v,
      ): v is string => v !== null);
      pushMetadata(lines, "Fiscal year", c.row.fiscal_year);
      pushMetadata(lines, "Department", c.row.department);
      pushMetadata(lines, "Program", c.row.program);
      pushMetadata(lines, "Indicator", c.row.indicator_name);
      pushMetadata(lines, "Actual", c.row.value_actual);
      pushMetadata(lines, "Target", c.row.value_target);
      pushMetadata(lines, "Prior year", c.row.value_prior_year);
      pushMetadata(lines, "Unit", c.row.unit);
      return lines.join("\n");
    }
    case "narrative_chunks":
      return asText(c.row.content) ?? "";
  }
}

function candidatePage(c: EnrichedCandidate): number | null {
  return asNumber(c.row.page_number_start) ?? asNumber(c.row.page_number_end);
}

function candidateBbox(c: EnrichedCandidate): unknown | null {
  const start = c.row.bbox_start ?? null;
  const end = c.row.bbox_end ?? null;
  if (start === null && end === null) return null;
  if (JSON.stringify(start) === JSON.stringify(end)) return start;
  return { start, end };
}

/**
 * Serialize one enriched candidate into a compact text block for the judge prompt.
 * Chunk text is truncated at 600 chars to keep the context window manageable.
 */
function serializeChunk(c: EnrichedCandidate, index: number): string {
  const lines: string[] = [];

  const meta: string[] = [`[${index + 1}] id=${c.id} | table=${c.table}`];

  if (c.table === "ordinance_provisions") {
    const isCurrent = c.row.is_current ?? "unknown";
    const effectiveDate = c.row.effective_date ?? "unknown";
    meta.push(`municode_node_id=${c.municode_node_id ?? "unknown"}`);
    meta.push(`is_current=${isCurrent}`);
    meta.push(`effective_date=${effectiveDate}`);
    meta.push(`superseded_date=${c.superseded_date ?? "null"}`);
    if (c.hasAmendmentHistory) {
      meta.push("has_amendment_history=true");
    }
    if (c.ancestors.length > 0) {
      meta.push(`ancestors=${c.ancestors.map((a) => a.title).join(" > ")}`);
    }
  }

  lines.push(meta.join(" | "));

  const rawText = candidateText(c);
  const truncated = rawText.length > 600
    ? rawText.slice(0, 600) + "…"
    : rawText;
  lines.push(`    ${truncated}`);

  return lines.join("\n");
}

/**
 * Try to extract a JSON object from the LLM response string.
 * The model sometimes wraps output in markdown fences or adds leading prose.
 * Returns null if no valid JSON object can be extracted.
 */
function extractJson(raw: string): unknown | null {
  // Strip markdown code fences if present
  const stripped = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Validate and normalise the raw parsed object into a typed JudgeOutput.
 * Returns null if required fields are missing or malformed.
 */
function validateJudgeOutput(
  raw: unknown,
  validIds: Set<string>,
): JudgeOutput | null {
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.selected_chunk_ids)) return null;
  if (typeof obj.temporal_flag !== "boolean") return null;

  // Clamp to JUDGE_OUTPUT_LIMIT and drop any IDs that weren't in the input.
  const selectedIds = (obj.selected_chunk_ids as unknown[])
    .filter((id): id is string => typeof id === "string" && validIds.has(id))
    .slice(0, JUDGE_OUTPUT_LIMIT);

  const amendmentCaveat = typeof obj.amendment_caveat === "string"
    ? obj.amendment_caveat
    : null;
  const pendingChangeNotice = typeof obj.pending_change_notice === "string"
    ? obj.pending_change_notice
    : null;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";

  return {
    selected_chunk_ids: selectedIds,
    temporal_flag: obj.temporal_flag as boolean,
    amendment_caveat: amendmentCaveat,
    pending_change_notice: pendingChangeNotice,
    reasoning,
  };
}

/**
 * Call the Temporal Judge LLM to filter and version-select the candidate chunks.
 *
 * Returns null if Ollama is exhausted (caller must return OLLAMA_EXHAUSTED error).
 * Never falls back to the unfiltered chunk set on exhaustion — the build plan
 * explicitly forbids silent fallback (AC 7).
 */
async function runTemporalJudge(
  userQuery: string,
  candidates: EnrichedCandidate[],
  pendingChanges: PendingChange[],
): Promise<TemporalJudgeResult | null> {
  const todayIso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // ── System prompt ────────────────────────────────────────────────────────────
  //
  // Design rationale (highest-risk prompt in the system):
  // • Temporal filtering must be explicit and rule-ordered to prevent the model
  //   from silently mixing versions. Rules are numbered for auditability.
  // • The model is told that superseded chunks exist alongside current ones and
  //   must make a deliberate selection, not simply rank by relevance.
  // • JSON-only output is demanded in both the system and user turns so the
  //   instruction is reinforced at the boundary where the model starts generating.
  // • The `reasoning` field gives an internal audit trail without a free-text
  //   preamble that could corrupt the JSON parser.

  const systemPrompt =
    `You are the Temporal Judge for a municipal policy Q&A system (Fairfax County, Virginia).

TASK
Given a user query and up to ${JUDGE_CONTEXT_COUNT} retrieved document chunks, select the ≤${JUDGE_OUTPUT_LIMIT} most relevant, temporally correct chunks to use when answering the query.

TEMPORAL SELECTION RULES (apply in order — stop at the first rule that matches)
1. HISTORICAL QUERY: If the query explicitly references a past date or time period (e.g., "as of 2019", "before the 2023 amendment", "what was the rule in January 2021", "prior to the change"), select chunks whose version was effective at the referenced date. A chunk was effective at date D when: effective_date ≤ D AND (superseded_date IS NULL OR superseded_date > D). Include superseded chunks only in this case.
2. CURRENT QUERY (default): For any query without a historical date reference, prefer current versions. For ordinance_provisions chunks: identify chunks that share the same municode_node_id. If is_current=false AND a chunk with the same municode_node_id and is_current=true is also in the candidate list, REMOVE the superseded chunk. If no current version exists for that section, you may keep the superseded chunk but note this in amendment_caveat.
3. NON-ORDINANCE CHUNKS (vote_tallies, policy_decisions, budget_indicators, narrative_chunks): No temporal filtering — evaluate purely by relevance.

OUTPUT RULES
• Select at most ${JUDGE_OUTPUT_LIMIT} chunk IDs total. Preserve relevance order (lower index = higher relevance from retrieval).
• temporal_flag = true if ANY of these occurred: (a) historical date detected in query, (b) one or more superseded chunks were filtered out, (c) multiple versions of the same section were compared.
• amendment_caveat: non-null string if ANY selected chunk has has_amendment_history=true in its metadata, OR if the chunk metadata shows superseded_date is non-null. In those cases, set a brief note like "Note: Section [id] was recently amended — verify you have the current version." Set to null ONLY if no amendment history signal is present for any selected chunk.
• pending_change_notice: one sentence if any pending_changes items are listed below; describe what is pending. Otherwise null.

CRITICAL: Output ONLY valid JSON — no preamble, no markdown fences, no explanation outside the JSON object. Schema:
{
  "selected_chunk_ids": ["<id>", "..."],
  "temporal_flag": true | false,
  "amendment_caveat": "<one sentence>" | null,
  "pending_change_notice": "<one sentence>" | null,
  "reasoning": "<one sentence explaining the key temporal decision made>"
}`;

  // ── User prompt ──────────────────────────────────────────────────────────────

  const chunkBlocks = candidates.map((c, i) => serializeChunk(c, i)).join(
    "\n\n",
  );

  const pendingBlock = pendingChanges.length === 0
    ? "None"
    : pendingChanges.map((p) =>
      `• node=${p.municode_node_id}: ${
        p.proposed_text ? p.proposed_text.slice(0, 200) : "(no proposed text)"
      }`
    ).join("\n");

  const userPrompt = `Query: ${userQuery}

Today's date: ${todayIso}

Retrieved chunks (${candidates.length} total, highest-relevance first):
${chunkBlocks}

Pending code changes (codification_status='pending'):
${pendingBlock}

Output JSON only:`;

  const { content, exhausted } = await ollamaChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    TEMPORAL_JUDGE_TEMPERATURE,
  );

  if (exhausted) {
    console.error("[temporal-judge] Ollama exhausted after all retries");
    return null;
  }

  // ── Parse and validate LLM output ───────────────────────────────────────────

  const parsed = extractJson(content);
  if (parsed === null) {
    console.error(
      "[temporal-judge] JSON extraction failed; raw response:",
      content.slice(0, 400),
    );
    return null;
  }

  const validIds = new Set(candidates.map((c) => c.id));
  const judgeOutput = validateJudgeOutput(parsed, validIds);

  if (judgeOutput === null) {
    console.error(
      "[temporal-judge] schema validation failed; parsed:",
      JSON.stringify(parsed).slice(0, 400),
    );
    return null;
  }

  console.log(`[temporal-judge] reasoning: ${judgeOutput.reasoning}`);
  console.log(
    `[temporal-judge] selected ${judgeOutput.selected_chunk_ids.length} of ${candidates.length} chunks; temporal_flag=${judgeOutput.temporal_flag}`,
  );

  // Filter candidates to only those selected by the judge, preserving their
  // original RRF order (the judge's selected_chunk_ids list carries relevance order).
  const idIndex = new Map(
    judgeOutput.selected_chunk_ids.map((id, i) => [id, i]),
  );
  const filteredCandidates = candidates
    .filter((c) => idIndex.has(c.id))
    .sort((a, b) => (idIndex.get(a.id) ?? 999) - (idIndex.get(b.id) ?? 999));

  return {
    filteredCandidates,
    temporalFlag: judgeOutput.temporal_flag,
    amendmentCaveat: judgeOutput.amendment_caveat,
    pendingChangeNotice: judgeOutput.pending_change_notice,
  };
}

// ── Scripted FK traversal ────────────────────────────────────────────────────

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

/**
 * After the Temporal Judge selects the answer context, deterministically fetch
 * linked rows that must travel with the selected chunk even when they had no
 * BM25/vector score of their own.
 */
async function traverseForeignKeys(
  candidates: EnrichedCandidate[],
): Promise<FkTraversalResult> {
  const seenKeys = new Set(candidates.map((c) => c.key));

  const reconsiderationIds = [
    ...new Set(
      candidates
        .filter((c) => c.table === "vote_tallies")
        .map((c) => c.row.reconsidered_by)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ].filter((id) => !seenKeys.has(`vote_tallies:${id}`));

  const amendedDecisionIds = [
    ...new Set(
      candidates
        .filter((c) => c.table === "policy_decisions")
        .map((c) => c.row.amends_decision_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ].filter((id) => !seenKeys.has(`policy_decisions:${id}`));

  const appended: EnrichedCandidate[] = [];

  if (reconsiderationIds.length > 0) {
    const { data, error: dbErr } = await db
      .from("vote_tallies")
      .select("*")
      .in("id", reconsiderationIds);

    if (dbErr) {
      console.error("vote_tallies FK traversal error:", dbErr.message);
      return {
        ok: false,
        message: "Failed to fetch linked reconsideration vote context.",
      };
    }

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const linked = fkCandidate("vote_tallies", row);
      if (!seenKeys.has(linked.key)) {
        appended.push(linked);
        seenKeys.add(linked.key);
      }
    }
  }

  if (amendedDecisionIds.length > 0) {
    const { data, error: dbErr } = await db
      .from("policy_decisions")
      .select("*")
      .in("id", amendedDecisionIds);

    if (dbErr) {
      console.error("policy_decisions FK traversal error:", dbErr.message);
      return {
        ok: false,
        message: "Failed to fetch linked amended decision context.",
      };
    }

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const linked = fkCandidate("policy_decisions", row);
      if (!seenKeys.has(linked.key)) {
        appended.push(linked);
        seenKeys.add(linked.key);
      }
    }
  }

  return { ok: true, candidates: [...candidates, ...appended] };
}

// ── Completeness check ───────────────────────────────────────────────────────

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

// ── Answer Drafter ───────────────────────────────────────────────────────────

async function fetchSourceDocuments(
  candidates: EnrichedCandidate[],
): Promise<Map<string, SourceDocument>> {
  const documentIds = [
    ...new Set(
      candidates
        .map((c) => c.row.document_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];

  if (documentIds.length === 0) return new Map();

  const { data, error: dbErr } = await db
    .from("documents")
    .select(
      "id, url, title, filename, ingested_at, doc_type, source_published_at, fiscal_year",
    )
    .in("id", documentIds);

  if (dbErr) {
    console.error("document source lookup error:", dbErr.message);
    return new Map();
  }

  return new Map(
    ((data ?? []) as SourceDocument[]).map((doc) => [doc.id, doc]),
  );
}

// Human-readable labels for documents.doc_type, keyed by the CHECK constraint
// values in migrations 001/20260710123000. Used only when a document has no
// real title/filename — never surface the raw doc_type or table name to users.
const DOC_TYPE_LABELS: Record<string, string> = {
  bos_summary: "Board Summary",
  bos_minutes: "Board Minutes",
  budget_pdf: "Budget Document",
  municode_api: "Municode Ordinance",
  encode_zoning: "Zoning Ordinance",
};

// Last-resort labels when there's no document row at all (e.g. a dangling
// document_id) — still human-readable, keyed by CHUNK_TABLES.
const CHUNK_TABLE_LABELS: Record<ChunkTable, string> = {
  ordinance_provisions: "Ordinance Provision",
  vote_tallies: "Vote Tally",
  policy_decisions: "Policy Decision",
  budget_indicators: "Budget Indicator",
  narrative_chunks: "Document",
};

// The only per-document date available for most doc types today. Prefer
// source_published_at (the document's real-world date) but it is currently
// unpopulated for bos_summary/bos_minutes/budget_pdf at ingestion time, so
// this generally falls back to ingested_at (the scrape date, not the
// document's real date) — good enough to distinguish citations, but see
// PR notes for the underlying ingestion gap.
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

function buildAnnotatedDrafterChunks(
  candidates: EnrichedCandidate[],
  documents: Map<string, SourceDocument>,
): AnnotatedDrafterChunk[] {
  return candidates.map((c, index) => {
    const doc = typeof c.row.document_id === "string"
      ? documents.get(c.row.document_id)
      : undefined;
    const metadata: string[] = [`table=${c.table}`];

    if (c.table === "ordinance_provisions") {
      metadata.push(`municode_node_id=${c.municode_node_id ?? "unknown"}`);
      metadata.push(
        `is_current=${formatUnknown(c.row.is_current ?? "unknown")}`,
      );
      metadata.push(
        `effective_date=${formatUnknown(c.row.effective_date ?? "unknown")}`,
      );
      metadata.push(`superseded_date=${c.superseded_date ?? "null"}`);
      if (c.ancestors.length > 0) {
        metadata.push(
          `ancestors=${c.ancestors.map((a) => a.title).join(" > ")}`,
        );
      }
    }

    return {
      chunk_id: c.id,
      table: c.table,
      rank: index + 1,
      source_url: doc?.url ?? "",
      source_title: sourceTitle(doc, c),
      source_ingested_at: doc?.ingested_at ?? null,
      page: candidatePage(c),
      bbox: candidateBbox(c),
      text: candidateText(c),
      metadata,
    };
  });
}

function serializeDrafterChunk(chunk: AnnotatedDrafterChunk): string {
  return [
    `[${chunk.rank}] chunk_id=${chunk.chunk_id}`,
    `source_title=${chunk.source_title}`,
    `source_url=${chunk.source_url || "unknown"}`,
    `page=${chunk.page === null ? "null" : chunk.page}`,
    `bbox=${formatUnknown(chunk.bbox)}`,
    `metadata=${chunk.metadata.join(" | ")}`,
    "text:",
    chunk.text,
  ].join("\n");
}

async function prepareDrafterChunks(
  candidates: EnrichedCandidate[],
): Promise<AnnotatedDrafterChunk[]> {
  const documents = await fetchSourceDocuments(candidates);
  return buildAnnotatedDrafterChunks(candidates, documents);
}

function detectQuestionStyle(
  query: string,
): "terse" | "structured" | "conversational" {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (
    /\b(list|compare|break down|table|bullets?|steps?|summarize)\b/i.test(query)
  ) {
    return "structured";
  }
  if (words.length <= 8) return "terse";
  if (
    /\b(can you|could you|please|explain|walk me through|what does this mean)\b/i
      .test(query)
  ) {
    return "conversational";
  }
  return "structured";
}

function caveatList(
  amendmentCaveat: string | null,
  pendingChangeNotice: string | null,
  incompleteSearchWarning: boolean,
): string[] {
  const caveats = [amendmentCaveat, pendingChangeNotice]
    .filter((value): value is string =>
      typeof value === "string" && value.trim() !== ""
    )
    .map((value) => value.trim());

  if (incompleteSearchWarning) {
    caveats.push(VERSION_HISTORY_INCOMPLETE_CAVEAT);
  }

  return [...new Set(caveats)];
}

function withRequiredCaveats(answer: string, caveats: string[]): string {
  const missing = caveats.filter((caveat) => !answer.includes(caveat));
  if (missing.length === 0) return answer;
  return `${answer.trim()}\n\nCaveats: ${missing.join(" ")}`;
}

function validateDrafterOutput(
  raw: unknown,
  chunks: AnnotatedDrafterChunk[],
  caveats: string[],
): AnswerDraftResult | null {
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as Record<string, unknown>;
  if (typeof obj.answer !== "string" || obj.answer.trim() === "") return null;

  const chunksById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const rawCitationMap = obj.citation_map;
  if (
    typeof rawCitationMap !== "object" || rawCitationMap === null ||
    Array.isArray(rawCitationMap)
  ) {
    return null;
  }

  const citationMap: Record<string, CitationMapEntry> = {};
  const citedIds = new Set<string>();

  for (
    const [claim, value] of Object.entries(
      rawCitationMap as Record<string, unknown>,
    )
  ) {
    if (
      claim.trim() === "" || typeof value !== "object" || value === null ||
      Array.isArray(value)
    ) {
      return null;
    }

    const entry = value as Record<string, unknown>;
    const chunkId = typeof entry.chunk_id === "string" ? entry.chunk_id : null;
    if (chunkId === null || !chunksById.has(chunkId)) {
      return null;
    }

    const chunk = chunksById.get(chunkId)!;
    citationMap[claim] = {
      chunk_id: chunkId,
      page: chunk.page,
      bbox: chunk.bbox,
    };
    citedIds.add(chunkId);
  }

  const rawAnswer = obj.answer.trim();
  const isRefusal = rawAnswer.toLowerCase().includes("not in the documents");
  const answer = isRefusal
    ? "not in the documents"
    : withRequiredCaveats(rawAnswer, caveats);
  if (citedIds.size === 0 && !isRefusal) return null;

  const citedChunks = chunks.filter((chunk) => citedIds.has(chunk.chunk_id));
  const citations = citedChunks.map((chunk, index): CitationChunk => ({
    chunk_id: chunk.chunk_id,
    source_url: chunk.source_url,
    source_title: chunk.source_title,
    page_number: chunk.page,
    bbox: chunk.bbox,
    retrieved_at: chunk.source_ingested_at,
    formatted: formatCitation(
      chunk.source_title,
      chunk.page,
      chunk.source_ingested_at,
    ),
    rank: index + 1,
  }));

  const chunkText = Object.fromEntries(
    citedChunks.map((chunk) => [chunk.chunk_id, chunk.text]),
  );

  return { answer, citations, citationMap, chunkText };
}

function refusalDraft(): AnswerDraftResult {
  return {
    answer: "not in the documents",
    citations: [],
    citationMap: {},
    chunkText: {},
  };
}

async function runAnswerDrafter(
  userQuery: string,
  chunks: AnnotatedDrafterChunk[],
  caveats: string[],
): Promise<AnswerDraftResult | null> {
  if (chunks.length === 0) return refusalDraft();

  const styleHint = detectQuestionStyle(userQuery);

  const systemPrompt =
    `You are the Answer Drafter for a municipal policy Q&A system.

Use only the provided document chunks. Do not use outside knowledge.

Required behavior:
1. Detect the user's question style and adapt prose:
   - terse: answer in one or two concise sentences.
   - structured: use short paragraphs or bullets when comparison/listing helps.
   - conversational: answer plainly with enough context for a non-specialist.
2. If the chunks do not support the answer, answer exactly: "not in the documents".
3. Every document-supported textual claim must cite a chunk inline.
4. Every numeric claim must cite chunk_id, page, and bbox inline.
5. Use this inline citation format after each claim: [chunk_id=<id>; page=<page-or-null>; bbox=<bbox-or-null>].
6. Attach caveats when provided; caveats do not need document citations.
7. Output only valid JSON. No markdown fence and no prose outside JSON.

JSON schema:
{
  "answer": "<draft answer text with inline citations>",
  "citation_map": {
    "<claim text without inline citation>": {
      "chunk_id": "<one provided chunk_id>",
      "page": <number or null>,
      "bbox": <bbox object/array/string or null>
    }
  }
}`;

  const caveatBlock = caveats.length === 0 ? "None" : caveats.join("\n");
  const contextBlock = chunks.map(serializeDrafterChunk).join("\n\n---\n\n");

  const userPrompt = `User query:
${userQuery}

Question style hint from deterministic precheck: ${styleHint}. You may override it if the query clearly asks for a different style.

Caveats to attach if applicable:
${caveatBlock}

Annotated final context (${chunks.length} chunks, highest relevance first):
${contextBlock}

Output JSON only:`;

  const { content, exhausted } = await ollamaChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    ANSWER_DRAFTER_TEMPERATURE,
  );

  if (exhausted) {
    console.error("[answer-drafter] Ollama exhausted after all retries");
    return null;
  }

  const parsed = extractJson(content);
  if (parsed === null) {
    console.error(
      "[answer-drafter] JSON extraction failed; raw response:",
      content.slice(0, 400),
    );
    return null;
  }

  const draft = validateDrafterOutput(parsed, chunks, caveats);
  if (draft === null) {
    console.error(
      "[answer-drafter] schema validation failed; parsed:",
      JSON.stringify(parsed).slice(0, 400),
    );
    return null;
  }

  console.log(
    `[answer-drafter] drafted answer with ${draft.citations.length} cited chunks`,
  );
  return draft;
}

// ── Conditional Verifier + correction loop ──────────────────────────────────

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

function consumeLlmCall(budget: LlmCallBudget, label: string): boolean {
  if (!hasRemainingLlmCall(budget)) {
    console.error(
      `[${label}] LLM call cap reached (${budget.used}/${budget.cap}); skipping call`,
    );
    return false;
  }
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

function normalizeClaim(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseFlaggedClaims(
  raw: unknown,
  citationMap: Record<string, CitationMapEntry>,
  validChunkIds: Set<string>,
): FlaggedClaim[] | null {
  if (!Array.isArray(raw)) return null;

  const claimsByNormalized = new Map(
    Object.keys(citationMap).map((claim) => [normalizeClaim(claim), claim]),
  );
  const flagged: FlaggedClaim[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return null;
    }

    const obj = item as Record<string, unknown>;
    const rawClaim = typeof obj.claim === "string" ? obj.claim.trim() : "";
    const matchedClaim = claimsByNormalized.get(normalizeClaim(rawClaim)) ??
      rawClaim;
    const mappedChunkId = citationMap[matchedClaim]?.chunk_id;
    const rawChunkId = typeof obj.chunk_id === "string"
      ? obj.chunk_id.trim()
      : "";
    const chunkId = mappedChunkId ?? rawChunkId;
    const issue = typeof obj.issue === "string" ? obj.issue.trim() : "";
    const instruction = typeof obj.correction_instruction === "string"
      ? obj.correction_instruction.trim()
      : "";

    if (
      matchedClaim === "" || chunkId === "" || !validChunkIds.has(chunkId) ||
      issue === "" || instruction === ""
    ) {
      return null;
    }

    flagged.push({
      claim: matchedClaim,
      chunk_id: chunkId,
      issue,
      correction_instruction: instruction,
    });
  }

  return flagged;
}

function validateVerifierOutput(
  raw: unknown,
  draft: AnswerDraftResult,
): VerifierResult | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const validChunkIds = new Set(Object.keys(draft.chunkText));
  const flaggedClaims = parseFlaggedClaims(
    obj.flagged_claims,
    draft.citationMap,
    validChunkIds,
  );
  if (flaggedClaims === null) return null;

  return { flaggedClaims };
}

function validateCorrectionOutput(
  raw: unknown,
  chunks: AnnotatedDrafterChunk[],
  caveats: string[],
): CorrectionResult | null {
  const draft = validateDrafterOutput(raw, chunks, caveats);
  if (draft === null) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const validChunkIds = new Set(chunks.map((chunk) => chunk.chunk_id));
  const flaggedClaims = parseFlaggedClaims(
    obj.flagged_claims,
    draft.citationMap,
    validChunkIds,
  );
  if (flaggedClaims === null) return null;

  return { ...draft, flaggedClaims };
}

function serializeClaimEvidence(
  draft: AnswerDraftResult,
  chunks: AnnotatedDrafterChunk[],
): string {
  const chunksById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));

  return Object.entries(draft.citationMap).map(([claim, citation], index) => {
    const chunk = chunksById.get(citation.chunk_id);
    const text = draft.chunkText[citation.chunk_id] ?? chunk?.text ?? "";
    return [
      `[${index + 1}] claim: ${claim}`,
      `chunk_id=${citation.chunk_id}`,
      `page=${citation.page === null ? "null" : citation.page}`,
      `bbox=${formatUnknown(citation.bbox)}`,
      "chunk span:",
      text,
    ].join("\n");
  }).join("\n\n---\n\n");
}

function serializeFlaggedClaims(flaggedClaims: FlaggedClaim[]): string {
  if (flaggedClaims.length === 0) return "None";
  return flaggedClaims.map((flag, index) =>
    [
      `[${index + 1}] claim: ${flag.claim}`,
      `chunk_id=${flag.chunk_id}`,
      `issue=${flag.issue}`,
      `correction_instruction=${flag.correction_instruction}`,
    ].join("\n")
  ).join("\n\n");
}

async function runVerifier(
  userQuery: string,
  draft: AnswerDraftResult,
  chunks: AnnotatedDrafterChunk[],
  temporalFlag: boolean,
  budget: LlmCallBudget,
): Promise<VerifierResult | null> {
  if (!consumeLlmCall(budget, "verifier")) return null;

  const systemPrompt = `You are the Verifier for a municipal policy Q&A system.

Use only the provided cited claims and chunk spans. Do not use outside knowledge.

For every cited claim:
1. Confirm whether the claim accurately reflects the cited chunk span.
2. Numeric claims must match the cited chunk's numbers, units, dates, vote counts, percentages, money amounts, and qualifiers exactly.
3. Temporal claims must not mix current and superseded context; if temporal_flag=true, be strict about effective dates and caveats.
4. Flag any unsupported, overstated, contradicted, or under-qualified claim.
5. For each flagged claim, provide concrete correction instructions.

Output only valid JSON. No markdown fence and no prose outside JSON.

JSON schema:
{
  "flagged_claims": [
    {
      "claim": "<exact cited claim text>",
      "chunk_id": "<cited chunk_id>",
      "issue": "<what is unsupported or inaccurate>",
      "correction_instruction": "<how the answer should be revised>"
    }
  ]
}

If every cited claim is supported, return "flagged_claims": [].`;

  const userPrompt = `User query:
${userQuery}

temporal_flag=${temporalFlag}

Draft answer:
${draft.answer}

Cited claims and chunk spans:
${serializeClaimEvidence(draft, chunks)}

Output JSON only:`;

  const { content, exhausted } = await ollamaChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    VERIFIER_TEMPERATURE,
  );

  if (exhausted) {
    console.error("[verifier] Ollama exhausted after all retries");
    return null;
  }

  const parsed = extractJson(content);
  if (parsed === null) {
    console.error(
      "[verifier] JSON extraction failed; raw response:",
      content.slice(0, 400),
    );
    return null;
  }

  const result = validateVerifierOutput(parsed, draft);
  if (result === null) {
    console.error(
      "[verifier] schema validation failed; parsed:",
      JSON.stringify(parsed).slice(0, 400),
    );
    return null;
  }

  console.log(`[verifier] flagged ${result.flaggedClaims.length} claims`);
  return result;
}

async function runCorrectionPass(
  userQuery: string,
  currentDraft: AnswerDraftResult,
  chunks: AnnotatedDrafterChunk[],
  caveats: string[],
  flaggedClaims: FlaggedClaim[],
  passNumber: number,
  budget: LlmCallBudget,
): Promise<CorrectionResult | null> {
  if (!consumeLlmCall(budget, `correction-pass-${passNumber}`)) return null;

  const systemPrompt =
    `You are the Correction Drafter for a municipal policy Q&A system.

Use only the provided document chunks. Do not use outside knowledge.

Revise the answer to satisfy the verifier's correction instructions:
1. Fix inaccurate or unsupported claims.
2. Drop claims that cannot be supported by the chunks.
3. Preserve useful supported content from the previous answer.
4. Every document-supported textual claim must cite a chunk inline.
5. Every numeric claim must cite chunk_id, page, and bbox inline.
6. Use this inline citation format after each claim: [chunk_id=<id>; page=<page-or-null>; bbox=<bbox-or-null>].
7. Attach caveats when provided; caveats do not need document citations.
8. After revising, internally check each cited claim against its chunk span and list any remaining unsupported claims in flagged_claims.

Output only valid JSON. No markdown fence and no prose outside JSON.

JSON schema:
{
  "answer": "<revised answer text with inline citations>",
  "citation_map": {
    "<claim text without inline citation>": {
      "chunk_id": "<one provided chunk_id>",
      "page": <number or null>,
      "bbox": <bbox object/array/string or null>
    }
  },
  "flagged_claims": [
    {
      "claim": "<exact revised claim text>",
      "chunk_id": "<cited chunk_id>",
      "issue": "<what remains unsupported or inaccurate>",
      "correction_instruction": "<what would still be needed to fix it>"
    }
  ]
}

If all revised claims are supported, return "flagged_claims": [].`;

  const caveatBlock = caveats.length === 0 ? "None" : caveats.join("\n");
  const contextBlock = chunks.map(serializeDrafterChunk).join("\n\n---\n\n");

  const userPrompt = `User query:
${userQuery}

Correction pass: ${passNumber} of ${MAX_CORRECTION_PASSES}

Caveats to attach if applicable:
${caveatBlock}

Previous answer:
${currentDraft.answer}

Verifier flags to fix:
${serializeFlaggedClaims(flaggedClaims)}

Available chunks:
${contextBlock}

Output JSON only:`;

  const { content, exhausted } = await ollamaChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    VERIFIER_TEMPERATURE,
  );

  if (exhausted) {
    console.error(
      `[correction-pass-${passNumber}] Ollama exhausted after all retries`,
    );
    return null;
  }

  const parsed = extractJson(content);
  if (parsed === null) {
    console.error(
      `[correction-pass-${passNumber}] JSON extraction failed; raw response:`,
      content.slice(0, 400),
    );
    return null;
  }

  const result = validateCorrectionOutput(parsed, chunks, caveats);
  if (result === null) {
    console.error(
      `[correction-pass-${passNumber}] schema validation failed; parsed:`,
      JSON.stringify(parsed).slice(0, 400),
    );
    return null;
  }

  console.log(
    `[correction-pass-${passNumber}] remaining flagged claims: ${result.flaggedClaims.length}`,
  );
  return result;
}

async function runVerifierCorrectionLoop(
  userQuery: string,
  draft: AnswerDraftResult,
  chunks: AnnotatedDrafterChunk[],
  caveats: string[],
  temporalFlag: boolean,
  budget: LlmCallBudget,
): Promise<AnswerDraftResult | null> {
  if (!shouldRunVerifier(draft, temporalFlag)) {
    console.log("[verifier] skipped: no numeric claim and temporal_flag=false");
    return draft;
  }

  if (!hasRemainingLlmCall(budget)) {
    return withUnverifiedCaveat(draft);
  }

  const verifier = await runVerifier(
    userQuery,
    draft,
    chunks,
    temporalFlag,
    budget,
  );
  if (verifier === null) return null;

  let currentDraft = draft;
  let flaggedClaims = verifier.flaggedClaims;

  for (
    let passNumber = 1;
    passNumber <= MAX_CORRECTION_PASSES && flaggedClaims.length > 0;
    passNumber += 1
  ) {
    if (!hasRemainingLlmCall(budget)) {
      return withUnverifiedCaveat(currentDraft);
    }

    const correction = await runCorrectionPass(
      userQuery,
      currentDraft,
      chunks,
      caveats,
      flaggedClaims,
      passNumber,
      budget,
    );
    if (correction === null) return null;

    const { flaggedClaims: remainingFlags, ...correctedDraft } = correction;
    currentDraft = correctedDraft;
    flaggedClaims = remainingFlags;
  }

  if (flaggedClaims.length > 0) {
    return withUnverifiedCaveat(currentDraft);
  }

  return currentDraft;
}

// ── Response assembly + RequestLog persistence ──────────────────────────────

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

function isRefusalAnswer(answer: string): boolean {
  return answer.toLowerCase().includes("not in the documents");
}

function finalCaveats(answer: string, caveats: string[]): string[] {
  const combined = [...caveats];
  if (answer.includes(UNVERIFIED_CAVEAT)) {
    combined.push(UNVERIFIED_CAVEAT);
  }
  return [...new Set(combined.filter((caveat) => caveat.trim() !== ""))];
}

function assembleQueryResponse(
  draft: AnswerDraftResult,
  temporalFlag: boolean,
  amendmentCaveat: string | null,
  pendingChangeNotice: string | null,
  incompleteSearchWarning: boolean,
  caveats: string[],
): QueryResponseData {
  const freshnessTimestamp = mostRecentRetrievedAt(draft.citations);
  return {
    answer: formatInlineAnswerCitations(draft.answer, draft.citations),
    citations: draft.citations,
    citationMap: draft.citationMap,
    chunkText: draft.chunkText,
    temporalFlag,
    amendmentCaveat,
    pendingChangeNotice,
    incompleteSearchWarning,
    freshnessTimestamp,
    freshness: freshnessNotice(freshnessTimestamp),
    caveats: finalCaveats(draft.answer, caveats),
    deepHistoricalLookup: null,
  };
}

/**
 * Build a QueryResponseData for the deep-historical slow path (see
 * _deep-historical.ts). Reuses the same withRequiredCaveats/formatCitation/
 * freshnessNotice helpers as the normal path so the shape stays consistent —
 * the only new surface is `deepHistoricalLookup`, which is always non-null
 * here so the frontend can disclose that this response took the slow path.
 * "not_found" and "failed" outcomes both render as a refusal: never fabricate
 * just because the live lookup itself failed rather than came up genuinely
 * empty.
 */
function assembleDeepHistoricalResponse(
  outcome: DeepHistoricalOutcome,
): QueryResponseData {
  if (outcome.status === "answered") {
    const caveats = [
      `This answer required an extended live historical lookup against ${outcome.sourceLabel} (fetched just now) — it was not found in the standard pre-indexed corpus.`,
    ];
    const citation: CitationChunk = {
      chunk_id: outcome.citationId,
      source_url: outcome.sourceUrl,
      source_title: outcome.sourceLabel,
      page_number: outcome.page,
      bbox: null,
      retrieved_at: outcome.fetchedAt,
      formatted: formatCitation(
        outcome.sourceLabel,
        outcome.page,
        outcome.fetchedAt,
      ),
      rank: 1,
    };

    return {
      answer: withRequiredCaveats(outcome.answer, caveats),
      citations: [citation],
      citationMap: {},
      chunkText: { [outcome.citationId]: outcome.excerptText },
      temporalFlag: true,
      amendmentCaveat: null,
      pendingChangeNotice: null,
      incompleteSearchWarning: false,
      freshnessTimestamp: outcome.fetchedAt,
      freshness: freshnessNotice(outcome.fetchedAt),
      caveats,
      deepHistoricalLookup: {
        answered: true,
        sourceLabel: outcome.sourceLabel,
        sourceUrl: outcome.sourceUrl,
        fetchedAt: outcome.fetchedAt,
      },
    };
  }

  return {
    answer: "not in the documents",
    citations: [],
    citationMap: {},
    chunkText: {},
    temporalFlag: true,
    amendmentCaveat: null,
    pendingChangeNotice: null,
    incompleteSearchWarning: true,
    freshnessTimestamp: null,
    freshness: null,
    caveats: [
      `An extended live historical lookup against ${outcome.sourceLabel} was attempted but did not find an answer to this question.`,
    ],
    deepHistoricalLookup: {
      answered: false,
      sourceLabel: outcome.sourceLabel,
      sourceUrl: outcome.sourceUrl,
      fetchedAt: outcome.fetchedAt,
    },
  };
}

async function writeRequestLog(input: RequestLogInput): Promise<boolean> {
  const { error: dbErr } = await db.from("request_logs").insert({
    id: uuidv7(),
    ip_address: input.ip,
    query_text: input.queryText,
    response_ms: input.responseMs,
    chunk_count: input.chunkCount,
    llm_calls: input.llmCalls,
    temporal_flag: input.temporalFlag,
    verifier_flag: input.verifierFlag,
    refusal: input.refusal,
    incomplete_search: input.incompleteSearch,
  });

  if (dbErr) {
    console.error("request log write error:", dbErr.message);
    return false;
  }
  return true;
}

async function returnLoggedSuccess(
  data: QueryResponseData,
  startedAt: number,
  input: Omit<RequestLogInput, "responseMs" | "chunkCount" | "refusal">,
): Promise<Response> {
  const responseMs = Math.max(0, Math.round(performance.now() - startedAt));
  const logged = await writeRequestLog({
    ...input,
    responseMs,
    chunkCount: Object.keys(data.chunkText).length,
    refusal: isRefusalAnswer(data.answer),
  });

  if (!logged) {
    return error(
      "INGESTION_FAILED",
      "Service temporarily unavailable. Please retry.",
      503,
    );
  }

  return success<QueryResponseData>(data);
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const startedAt = performance.now();

  if (req.method === "OPTIONS") {
    return corsPreflightResponse();
  }

  if (req.method !== "POST") {
    return error("NOT_FOUND", "Method not allowed", 405);
  }

  let query: string;
  try {
    const body = (await req.json()) as QueryRequest;
    if (typeof body?.query !== "string" || !body.query.trim()) {
      return error(
        "NOT_FOUND",
        "Request body must contain a non-empty `query` string.",
        400,
      );
    }
    query = body.query.trim();
  } catch {
    return error("NOT_FOUND", "Invalid JSON body.", 400);
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  let llmCalls = 0;

  // ── Step 1: Rate limit ──────────────────────────────────────────────────────

  const allowed = await isWithinRateLimit(ip);
  if (!allowed) {
    return error(
      "RATE_LIMITED",
      "Too many requests. Please wait before retrying.",
      429,
    );
  }

  // Increment bucket BEFORE retrieval — every non-429 request must write a row.
  const bucketWritten = await writeBucket(ip);
  if (!bucketWritten) {
    return error(
      "INGESTION_FAILED",
      "Service temporarily unavailable. Please retry.",
      503,
    );
  }

  // ── Step 2: Embed query (Supabase AI Session — gte-small, 384d) ────────────

  const session = new Supabase.ai.Session("gte-small");

  let queryEmbedding: number[];
  try {
    queryEmbedding = await session.run(query, {
      mean_pool: true,
      normalize: true,
    });
  } catch (embedErr) {
    console.error("embedding error:", embedErr);
    return error("INGESTION_FAILED", "Failed to embed query.", 500);
  }

  // ── Step 3: Parallel BM25 + vector retrieval across all five tables ─────────

  const [bm25Raw, vectorRaw] = await Promise.all([
    Promise.all(CHUNK_TABLES.map((t) => bm25ForTable(t, query))),
    Promise.all(CHUNK_TABLES.map((t) => vectorForTable(t, queryEmbedding))),
  ]);

  const bm25Results = new Map<ChunkTable, Record<string, unknown>[]>(
    CHUNK_TABLES.map((t, i) => [t, bm25Raw[i]]),
  );
  const vectorResults = new Map<ChunkTable, Record<string, unknown>[]>(
    CHUNK_TABLES.map((t, i) => [t, vectorRaw[i]]),
  );

  // ── Step 4: RRF merge ───────────────────────────────────────────────────────

  const ranked = rrfMerge(bm25Results, vectorResults);

  // ── INCOMPLETE_SEARCH_FLOOR gate ────────────────────────────────────────────

  const maxScore = ranked[0]?.rrfScore ?? 0;
  if (maxScore < INCOMPLETE_SEARCH_FLOOR) {
    // ── Deep-historical slow path (see _deep-historical.ts) ───────────────────
    // Only attempted when the fast path found genuinely nothing AND the query
    // names a year within EnCode's reprint coverage AND the EnCode compliance
    // gate is on. Extended-timeout, explicitly-disclosed, never-fabricating —
    // see file header there for the full design rationale.
    const deepHistoricalTrigger = shouldAttemptDeepHistoricalLookup(
      query,
      maxScore,
      INCOMPLETE_SEARCH_FLOOR,
    );

    if (deepHistoricalTrigger.attempt) {
      // Approximate: this path has its own single-LLM-call budget, separate
      // from LLM_TOTAL_CALL_CAP (which governs the Judge/Drafter/Verifier
      // chain this path never enters). Counted here even on a pre-LLM
      // failure (Docling error, zero relevant excerpts) for simplicity — an
      // acceptable approximation for a log metric, not a hard invariant.
      llmCalls += 1;
      const outcome = await runDeepHistoricalLookup(
        db as unknown as PreingestDb,
        query,
        deepHistoricalTrigger.reprint,
      );
      const deepHistoricalResponse = assembleDeepHistoricalResponse(outcome);
      return await returnLoggedSuccess(deepHistoricalResponse, startedAt, {
        ip,
        queryText: query,
        llmCalls,
        temporalFlag: true,
        verifierFlag: false,
        incompleteSearch: outcome.status !== "answered",
      });
    }

    const incompleteResponse: QueryResponseData = {
      answer: "",
      citations: [] as CitationChunk[],
      citationMap: {},
      chunkText: {},
      temporalFlag: false,
      amendmentCaveat: null,
      pendingChangeNotice: null,
      incompleteSearchWarning: true,
      freshnessTimestamp: null,
      freshness: null,
      caveats: [],
      deepHistoricalLookup: null,
    };
    return await returnLoggedSuccess(incompleteResponse, startedAt, {
      ip,
      queryText: query,
      llmCalls,
      temporalFlag: false,
      verifierFlag: false,
      incompleteSearch: true,
    });
  }

  // ── Step 5 (task 2-8): Ancestor enrichment ─────────────────────────────────
  // Feed top JUDGE_CONTEXT_COUNT candidates (not just 8) so the judge has full
  // temporal coverage before filtering down to ≤8.

  const topN = ranked.slice(0, JUDGE_CONTEXT_COUNT);
  const enriched = await enrichWithAncestors(topN);

  // ── Step 6 (task 2-9): Temporal Judge ──────────────────────────────────────

  const historical = isHistoricalOnlyQuery(query);
  const budgetAnchored = historical
    ? enriched
    : await prependCurrentBudgetIndicators(query, enriched);
  const { filtered: preFiltered, amendedNodeIds } = hardFilterSuperseded(
    budgetAnchored,
    historical,
  );

  // Tag each remaining candidate so the judge sees has_amendment_history=true
  // for sections where a superseded peer was removed by the pre-filter.
  const taggedCandidates = preFiltered.map((c) => ({
    ...c,
    hasAmendmentHistory: c.table === "ordinance_provisions" &&
      c.municode_node_id !== undefined &&
      amendedNodeIds.has(c.municode_node_id),
  }));

  const currentAwareCandidates = await rerankCurrentStateCandidates(
    query,
    taggedCandidates,
  );

  const pendingChanges = await fetchPendingChanges(currentAwareCandidates);

  llmCalls += 1;
  const judgeResult = await runTemporalJudge(
    query,
    currentAwareCandidates,
    pendingChanges,
  );

  // AC 7: On Ollama exhaustion, return clean error — never silently fall back
  // to the unfiltered chunk set.
  if (judgeResult === null) {
    return error(
      "OLLAMA_EXHAUSTED",
      "Unable to process your query right now. Please try again in a moment.",
    );
  }

  const { filteredCandidates, pendingChangeNotice } = judgeResult;
  // AC3: pre-filter removing superseded chunks IS temporal reasoning — force flag even
  // if the LLM judge didn't set it independently.
  const temporalFlag = judgeResult.temporalFlag || amendedNodeIds.size > 0;

  // ── Step 7 (task 2-10): Scripted FK traversal ─────────────────────────────

  const fkTraversal = await traverseForeignKeys(filteredCandidates);
  if (!fkTraversal.ok) {
    return error("INGESTION_FAILED", fkTraversal.message, 500);
  }

  const finalContext = fkTraversal.candidates;

  // ── Step 8 (task 2-10): Completeness check ────────────────────────────────

  const completeness = applyCompletenessCheck(
    finalContext,
    temporalFlag,
    judgeResult.amendmentCaveat,
  );

  // ── Step 9 (task 2-11): Answer Drafter LLM call ──────────────────────────
  // Keep the drafter context at the build-plan ceiling. FK traversal appends
  // linked rows after the selected context, so lower-priority overflow rows are
  // excluded here rather than expanding the answer prompt beyond 8 chunks.

  const drafterContext = finalContext.slice(0, JUDGE_OUTPUT_LIMIT);
  const drafterChunks = await prepareDrafterChunks(drafterContext);
  const answerCaveats = caveatList(
    completeness.amendmentCaveat,
    pendingChangeNotice,
    completeness.incompleteSearchWarning,
  );
  if (drafterChunks.length > 0) {
    llmCalls += 1;
  }
  const draft = await runAnswerDrafter(
    query,
    drafterChunks,
    answerCaveats,
  );

  if (draft === null) {
    return error(
      "OLLAMA_EXHAUSTED",
      "Unable to process your query right now. Please try again in a moment.",
    );
  }

  // ── Step 10 (task 2-12): Conditional Verifier + correction loop ───────────

  const llmBudget: LlmCallBudget = {
    used: llmCalls,
    cap: LLM_TOTAL_CALL_CAP,
  };
  const verifierFlag = shouldRunVerifier(draft, temporalFlag) &&
    hasRemainingLlmCall(llmBudget);
  const verifiedDraft = await runVerifierCorrectionLoop(
    query,
    draft,
    drafterChunks,
    answerCaveats,
    temporalFlag,
    llmBudget,
  );

  if (verifiedDraft === null) {
    return error(
      "OLLAMA_EXHAUSTED",
      "Unable to process your query right now. Please try again in a moment.",
    );
  }
  llmCalls = llmBudget.used;

  // ── Step 11 (task 2-13): Response assembly + RequestLog ──────────────────

  const responseData = assembleQueryResponse(
    verifiedDraft,
    temporalFlag,
    completeness.amendmentCaveat,
    pendingChangeNotice,
    completeness.incompleteSearchWarning,
    answerCaveats,
  );
  return await returnLoggedSuccess(responseData, startedAt, {
    ip,
    queryText: query,
    llmCalls,
    temporalFlag,
    verifierFlag,
    incompleteSearch: completeness.incompleteSearchWarning,
  });
});
