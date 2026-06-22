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
 *
 * TODO task 2-10: FK traversal on filteredCandidates
 * TODO task 2-11: Answer Drafter LLM call
 * TODO task 2-12: Verifier LLM call
 * TODO task 2-13: Freshness timestamp
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { error, success } from "../_shared/response.ts";
import { ollamaChat } from "../_shared/ollama-client.ts";
import { type AiSession } from "../_shared/embedder.ts";
import { type CitationChunk, type QueryRequest, type QueryResponseData } from "../_shared/types.ts";

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
  ancestors: Array<{ municode_node_id: string; title: string; node_depth: number }>;
  /** The Municode node identity key for ordinance_provisions chunks; undefined for other tables. */
  municode_node_id: string | undefined;
  /** Computed from peer candidates: effective_date of the current version when this chunk is superseded; null otherwise. */
  superseded_date: string | null;
  /** True when hardFilterSuperseded removed at least one superseded peer for this node — signals amendment history to the judge. */
  hasAmendmentHistory: boolean;
}

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

// ── Ancestor enrichment ───────────────────────────────────────────────────────

/**
 * For each ordinance_provisions candidate, fetch all ancestor nodes via a
 * single batched recursive DB call and attach them as metadata.
 * Ancestors do NOT count toward the 8-chunk ceiling.
 * Non-fatal: if the DB call fails, candidates are returned without ancestors.
 */
async function enrichWithAncestors(candidates: RankedCandidate[]): Promise<EnrichedCandidate[]> {
  const ordinanceCandidates = candidates.filter(c => c.table === 'ordinance_provisions');

  const parentNodeIds = [...new Set(
    ordinanceCandidates
      .map(c => c.row.parent_node_id as string | null)
      .filter((pid): pid is string => pid !== null)
  )];

  const ancestorMap = new Map<string, { municode_node_id: string; parent_node_id: string | null; title: string; node_depth: number }>();

  if (parentNodeIds.length > 0) {
    const { data, error: ancestorErr } = await db.rpc('get_ordinance_ancestors', {
      p_node_ids: parentNodeIds,
    });
    if (ancestorErr) {
      console.error('ancestor lookup error:', ancestorErr.message);
    } else {
      for (const row of (data ?? [])) {
        ancestorMap.set(row.municode_node_id, row);
      }
    }
  }

  // First pass: attach ancestor chains and municode_node_id to each candidate.
  const withAncestors = candidates.map(c => {
    const nodeId = c.table === 'ordinance_provisions'
      ? (c.row.municode_node_id as string | undefined)
      : undefined;

    if (c.table !== 'ordinance_provisions') {
      return { ...c, ancestors: [], municode_node_id: undefined, superseded_date: null, hasAmendmentHistory: false };
    }

    const myParentId = c.row.parent_node_id as string | null;
    if (!myParentId) {
      return { ...c, ancestors: [], municode_node_id: nodeId, superseded_date: null, hasAmendmentHistory: false };
    }

    const ancestors: Array<{ municode_node_id: string; title: string; node_depth: number }> = [];
    let currentId: string | null = myParentId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const ancestor = ancestorMap.get(currentId);
      if (!ancestor) break;
      ancestors.push({ municode_node_id: ancestor.municode_node_id, title: ancestor.title, node_depth: ancestor.node_depth });
      currentId = ancestor.parent_node_id;
    }
    ancestors.sort((a, b) => a.node_depth - b.node_depth);
    return { ...c, ancestors, municode_node_id: nodeId, superseded_date: null, hasAmendmentHistory: false };
  });

  // Second pass: for is_current=false provisions, derive superseded_date from the
  // effective_date of the current version of the same node if it's in the candidate set.
  const currentVersionDates = new Map<string, string>();
  for (const c of withAncestors) {
    if (c.table === 'ordinance_provisions' && c.row.is_current === true && c.municode_node_id) {
      const effDate = c.row.effective_date as string | null;
      if (effDate) currentVersionDates.set(c.municode_node_id, effDate);
    }
  }

  return withAncestors.map(c => {
    if (c.table !== 'ordinance_provisions' || c.row.is_current === true || !c.municode_node_id) {
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
async function fetchPendingChanges(candidates: EnrichedCandidate[]): Promise<PendingChange[]> {
  const ordinanceMunicodeIds = candidates
    .filter(c => c.table === 'ordinance_provisions' && c.municode_node_id)
    .map(c => c.municode_node_id as string);

  const uniqueIds = [...new Set(ordinanceMunicodeIds)];
  if (uniqueIds.length === 0) return [];

  const { data, error: dbErr } = await db
    .from('pending_code_changes')
    .select('id, municode_node_id, codification_status, proposed_text')
    .in('municode_node_id', uniqueIds)
    .eq('codification_status', 'pending');

  if (dbErr) {
    console.error('pending changes lookup error:', dbErr.message);
    return [];
  }

  return (data ?? []) as PendingChange[];
}

// ── Hard pre-filter ───────────────────────────────────────────────────────────

/** Heuristic: detect queries that reference a specific past date or time period. */
function isHistoricalQuery(query: string): boolean {
  return /\b(19|20)\d{2}\b/.test(query) ||
    /\b(as of|at the time of|before the|prior to|in january|in february|in march|in april|in may|in june|in july|in august|in september|in october|in november|in december)\b/i.test(query);
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
      .filter(c => c.table === 'ordinance_provisions' && c.row.is_current === true)
      .map(c => c.municode_node_id)
      .filter((id): id is string => id !== undefined),
  );

  const amendedNodeIds = new Set<string>();
  const filtered = candidates.filter(c => {
    if (c.table !== 'ordinance_provisions') return true;
    if (c.row.is_current === true) return true;
    const shouldRemove = currentNodeIds.has(c.municode_node_id);
    if (shouldRemove && c.municode_node_id) amendedNodeIds.add(c.municode_node_id);
    return !shouldRemove;
  });

  return { filtered, amendedNodeIds };
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

/**
 * Serialize one enriched candidate into a compact text block for the judge prompt.
 * Chunk text is truncated at 600 chars to keep the context window manageable.
 */
function serializeChunk(c: EnrichedCandidate, index: number): string {
  const lines: string[] = [];

  const meta: string[] = [`[${index + 1}] id=${c.id} | table=${c.table}`];

  if (c.table === 'ordinance_provisions') {
    const isCurrent = c.row.is_current ?? 'unknown';
    const effectiveDate = c.row.effective_date ?? 'unknown';
    meta.push(`municode_node_id=${c.municode_node_id ?? 'unknown'}`);
    meta.push(`is_current=${isCurrent}`);
    meta.push(`effective_date=${effectiveDate}`);
    meta.push(`superseded_date=${c.superseded_date ?? 'null'}`);
    if (c.hasAmendmentHistory) {
      meta.push('has_amendment_history=true');
    }
    if (c.ancestors.length > 0) {
      meta.push(`ancestors=${c.ancestors.map(a => a.title).join(' > ')}`);
    }
  }

  lines.push(meta.join(' | '));

  const rawText =
    (c.row.chunk_text ?? c.row.content_text ?? c.row.text ?? '') as string;
  const truncated = rawText.length > 600 ? rawText.slice(0, 600) + '…' : rawText;
  lines.push(`    ${truncated}`);

  return lines.join('\n');
}

/**
 * Try to extract a JSON object from the LLM response string.
 * The model sometimes wraps output in markdown fences or adds leading prose.
 * Returns null if no valid JSON object can be extracted.
 */
function extractJson(raw: string): unknown | null {
  // Strip markdown code fences if present
  const stripped = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
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
function validateJudgeOutput(raw: unknown, validIds: Set<string>): JudgeOutput | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.selected_chunk_ids)) return null;
  if (typeof obj.temporal_flag !== 'boolean') return null;

  // Clamp to JUDGE_OUTPUT_LIMIT and drop any IDs that weren't in the input.
  const selectedIds = (obj.selected_chunk_ids as unknown[])
    .filter((id): id is string => typeof id === 'string' && validIds.has(id))
    .slice(0, JUDGE_OUTPUT_LIMIT);

  const amendmentCaveat =
    typeof obj.amendment_caveat === 'string' ? obj.amendment_caveat : null;
  const pendingChangeNotice =
    typeof obj.pending_change_notice === 'string' ? obj.pending_change_notice : null;
  const reasoning =
    typeof obj.reasoning === 'string' ? obj.reasoning : '';

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

  const systemPrompt = `You are the Temporal Judge for a municipal policy Q&A system (Fairfax County, Virginia).

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

  const chunkBlocks = candidates.map((c, i) => serializeChunk(c, i)).join('\n\n');

  const pendingBlock = pendingChanges.length === 0
    ? 'None'
    : pendingChanges.map(p =>
        `• node=${p.municode_node_id}: ${p.proposed_text ? p.proposed_text.slice(0, 200) : '(no proposed text)'}`
      ).join('\n');

  const userPrompt =
    `Query: ${userQuery}

Today's date: ${todayIso}

Retrieved chunks (${candidates.length} total, highest-relevance first):
${chunkBlocks}

Pending code changes (codification_status='pending'):
${pendingBlock}

Output JSON only:`;

  const { content, exhausted } = await ollamaChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    TEMPORAL_JUDGE_TEMPERATURE,
  );

  if (exhausted) {
    console.error('[temporal-judge] Ollama exhausted after all retries');
    return null;
  }

  // ── Parse and validate LLM output ───────────────────────────────────────────

  const parsed = extractJson(content);
  if (parsed === null) {
    console.error('[temporal-judge] JSON extraction failed; raw response:', content.slice(0, 400));
    return null;
  }

  const validIds = new Set(candidates.map(c => c.id));
  const judgeOutput = validateJudgeOutput(parsed, validIds);

  if (judgeOutput === null) {
    console.error('[temporal-judge] schema validation failed; parsed:', JSON.stringify(parsed).slice(0, 400));
    return null;
  }

  console.log(`[temporal-judge] reasoning: ${judgeOutput.reasoning}`);
  console.log(`[temporal-judge] selected ${judgeOutput.selected_chunk_ids.length} of ${candidates.length} chunks; temporal_flag=${judgeOutput.temporal_flag}`);

  // Filter candidates to only those selected by the judge, preserving their
  // original RRF order (the judge's selected_chunk_ids list carries relevance order).
  const idIndex = new Map(judgeOutput.selected_chunk_ids.map((id, i) => [id, i]));
  const filteredCandidates = candidates
    .filter(c => idIndex.has(c.id))
    .sort((a, b) => (idIndex.get(a.id) ?? 999) - (idIndex.get(b.id) ?? 999));

  return {
    filteredCandidates,
    temporalFlag: judgeOutput.temporal_flag,
    amendmentCaveat: judgeOutput.amendment_caveat,
    pendingChangeNotice: judgeOutput.pending_change_notice,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return error("NOT_FOUND", "Method not allowed", 405);
  }

  let query: string;
  try {
    const body = (await req.json()) as QueryRequest;
    if (typeof body?.query !== "string" || !body.query.trim()) {
      return error("NOT_FOUND", "Request body must contain a non-empty `query` string.", 400);
    }
    query = body.query.trim();
  } catch {
    return error("NOT_FOUND", "Invalid JSON body.", 400);
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  // ── Step 1: Rate limit ──────────────────────────────────────────────────────

  const allowed = await isWithinRateLimit(ip);
  if (!allowed) {
    return error("RATE_LIMITED", "Too many requests. Please wait before retrying.", 429);
  }

  // Increment bucket BEFORE retrieval — every non-429 request must write a row.
  const bucketWritten = await writeBucket(ip);
  if (!bucketWritten) {
    return error("INGESTION_FAILED", "Service temporarily unavailable. Please retry.", 503);
  }

  // ── Step 2: Embed query (Supabase AI Session — gte-small, 384d) ────────────

  const session = new Supabase.ai.Session("gte-small");

  let queryEmbedding: number[];
  try {
    queryEmbedding = await session.run(query, { mean_pool: true, normalize: true });
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
    const incompleteResponse: QueryResponseData = {
      answer: "",
      citations: [] as CitationChunk[],
      chunkText: {},
      temporalFlag: false,
      amendmentCaveat: null,
      pendingChangeNotice: null,
      incompleteSearchWarning: true,
      freshnessTimestamp: null,
    };
    return success<QueryResponseData>(incompleteResponse);
  }

  // ── Step 5 (task 2-8): Ancestor enrichment ─────────────────────────────────
  // Feed top JUDGE_CONTEXT_COUNT candidates (not just 8) so the judge has full
  // temporal coverage before filtering down to ≤8.

  const topN = ranked.slice(0, JUDGE_CONTEXT_COUNT);
  const enriched = await enrichWithAncestors(topN);

  // ── Step 6 (task 2-9): Temporal Judge ──────────────────────────────────────

  const historical = isHistoricalQuery(query);
  const { filtered: preFiltered, amendedNodeIds } = hardFilterSuperseded(enriched, historical);

  // Tag each remaining candidate so the judge sees has_amendment_history=true
  // for sections where a superseded peer was removed by the pre-filter.
  const taggedCandidates = preFiltered.map(c => ({
    ...c,
    hasAmendmentHistory:
      c.table === 'ordinance_provisions' &&
      c.municode_node_id !== undefined &&
      amendedNodeIds.has(c.municode_node_id),
  }));

  const pendingChanges = await fetchPendingChanges(taggedCandidates);

  const judgeResult = await runTemporalJudge(query, taggedCandidates, pendingChanges);

  // AC 7: On Ollama exhaustion, return clean error — never silently fall back
  // to the unfiltered chunk set.
  if (judgeResult === null) {
    return error(
      "OLLAMA_EXHAUSTED",
      "Unable to process your query right now. Please try again in a moment.",
    );
  }

  const { filteredCandidates, amendmentCaveat, pendingChangeNotice } = judgeResult;
  // AC3: pre-filter removing superseded chunks IS temporal reasoning — force flag even
  // if the LLM judge didn't set it independently.
  const temporalFlag = judgeResult.temporalFlag || amendedNodeIds.size > 0;

  // ── TODO task 2-10: FK traversal on filteredCandidates ─────────────────────
  // ── TODO task 2-11: Answer Drafter LLM call ────────────────────────────────
  // ── TODO task 2-12: Verifier LLM call ──────────────────────────────────────
  // ── TODO task 2-13: Freshness timestamp ────────────────────────────────────

  // Incomplete pipeline response — steps 2-10 through 2-13 not yet implemented.
  // filteredCandidates holds the ≤8 temporally-filtered chunks ready for FK
  // traversal (task 2-10) and the Answer Drafter (task 2-11).
  const incompleteResponse: QueryResponseData = {
    answer: "",
    citations: [] as CitationChunk[],
    chunkText: {},
    temporalFlag,
    amendmentCaveat,
    pendingChangeNotice,
    incompleteSearchWarning: false,
    freshnessTimestamp: null,
  };
  return success<QueryResponseData>(incompleteResponse);
});
