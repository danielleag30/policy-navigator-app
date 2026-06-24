/**
 * query-pipeline — Query Pipeline Edge Function (tasks 2-7 through 2-13)
 *
 * This file implements task 2-7: rate limiting + parallel retrieval + RRF merge.
 * Later tasks (2-8 through 2-13) will extend this function.
 *
 * Request:  POST  { query: string }
 * Response: SuccessEnvelope<QueryPipelineResult> | ErrorEnvelope
 *
 * Pipeline (task 2-7):
 *  1. Rate limit check — 429 if exceeded; increment bucket row for all non-429
 *  2. Embed query via Supabase AI Session (gte-small, 384d)
 *  3. Parallel BM25 + vector retrieval across five chunk-bearing tables (40 each)
 *  4. RRF merge with table-qualified dedup keys: '{table}:{id}'
 *  5. INCOMPLETE_SEARCH_FLOOR gate — return early if max RRF score below floor
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { error, success } from "../_shared/response.ts";
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

  return candidates.map(c => {
    if (c.table !== 'ordinance_provisions') return { ...c, ancestors: [] };

    const myParentId = c.row.parent_node_id as string | null;
    if (!myParentId) return { ...c, ancestors: [] };

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
    return { ...c, ancestors };
  });
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
      citationMap: {},
      chunkText: {},
      temporalFlag: false,
      amendmentCaveat: null,
      pendingChangeNotice: null,
      incompleteSearchWarning: true,
      freshnessTimestamp: null,
      freshness: null,
      caveats: [],
    };
    return success<QueryResponseData>(incompleteResponse);
  }

  const top8 = ranked.slice(0, 8);
  const enriched = await enrichWithAncestors(top8);
  return success({ candidates: enriched, total: ranked.length });
});
