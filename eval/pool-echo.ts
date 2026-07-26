/**
 * eval/pool-echo.ts — retrieval-pool instrumentation ("pool echo") for the eval
 * harness. Prerequisite for measuring the §5.2.2 citation router: it lets each
 * case distinguish a RETRIEVAL failure (the gold chunk never surfaced) from a
 * POST-RETRIEVAL failure (the gold surfaced but the judge/drafter dropped it).
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The query-pipeline HTTP response (QueryResponseData) only exposes the ≤8
 * chunks the Answer Drafter *finally cited* (`citations`) plus `chunkText` for
 * those. It never exposes the ~40-per-arm retrieval candidate pool that RRF
 * merges and the Temporal Judge / Answer Drafter then select from. So from the
 * response alone the runner cannot tell "retrieval never surfaced the gold"
 * (router/ranking problem) from "retrieval surfaced it and something downstream
 * dropped it" (judge-window / drafter problem). Reconstructing the pool is the
 * only way to attribute a failing case to the correct stage — and the exact gap
 * that let a prior analysis overcount "retrieval-blind" failures.
 *
 * HOW IT STAYS FAITHFUL TO THE PIPELINE
 * -------------------------------------
 * query-pipeline/index.ts fans retrieval out over five chunk-bearing tables,
 * calling for each:
 *     db.rpc(`bm25_${table}`,  { p_query_text, p_limit: 40 })
 *     db.rpc(`match_${table}`, { query_embedding, match_count: 40 })
 * and rrfMerge() keys every candidate by `${table}:${id}`, using each row's
 * 1-based index *within its own table result* as rankBm25 / rankVector. This
 * module calls the SAME RPCs with the SAME arguments and reads back the SAME
 * per-table, 1-based ranks — it is a reconstruction of the pipeline's own
 * candidate pool, not a re-implementation of its scoring.
 *
 * THE VECTOR ARM EMBEDDING
 * ------------------------
 * The Edge Function embeds the query with the in-process
 * `Supabase.ai.Session('gte-small')`, which is only available inside the Supabase
 * Edge runtime. Off-Edge, the project's OTHER shipping embed path is used:
 * `generateEmbeddingsHttp` (supabase/functions/_shared/embedder.ts) against the
 * docling-wrapper `/embed` endpoint, which serves the SAME `thenlper/gte-small`
 * model with the SAME mean-pool + L2-normalize (docling-wrapper/app.py). Same
 * model + same pooling ⇒ vector ranks that match the pipeline's to within
 * float-precision noise. This is a documented, verified reconstruction — see the
 * spot-checks in the accompanying PR.
 *
 * SCOPE (stated honestly): this measures the CORE BM25+vector recall pool that
 * RRF merges — the well-defined "recall@40" baseline the owner asked for. It does
 * not attempt to reproduce the pipeline's narrow, query-shape-gated auxiliary
 * paths (deterministic ordinance current-value prefetch, budget-indicator
 * prepend, deep-historical slow path); those can only ADD chunks, so a
 * gold_in_pool=true here is a true lower-bound guarantee that retrieval surfaced
 * the gold.
 *
 * Pure functions here (goldRankInRows, summarizePoolEcho) are exported and have
 * no side effects, so tests exercise the REAL shipping aggregation logic against
 * fixtures without any network. The IO helpers are thin and injectable.
 */

import { generateEmbeddingsHttp } from "../supabase/functions/_shared/embedder.ts";

/**
 * The five chunk-bearing tables, in the SAME order query-pipeline/index.ts
 * declares CHUNK_TABLES. Order does not affect per-table ranks (each table is
 * ranked independently) but is kept identical for auditability.
 */
export const POOL_CHUNK_TABLES = [
  "ordinance_provisions",
  "vote_tallies",
  "policy_decisions",
  "budget_indicators",
  "narrative_chunks",
] as const;

export type PoolChunkTable = (typeof POOL_CHUNK_TABLES)[number];

/** Matches the pipeline's RETRIEVAL_CANDIDATE_COUNT default (40 per arm/table). */
export const POOL_CANDIDATE_COUNT = 40;

/** A retrieved row — we only need its id to locate the gold. */
export interface PoolRow {
  id: string;
}

/**
 * The additive, per-case pool-echo columns. Field names/semantics are exactly
 * what the runner persists alongside PR #137's durable per-case results.
 */
export interface PoolEcho {
  /** True iff at least one expected gold chunk_id appears in either arm's top-40
   *  candidate pool (i.e. gold_rank_bm25 !== null || gold_rank_vector !== null).
   *  This is the honest "retrieval surfaced the gold at all" signal. */
  gold_in_pool: boolean;
  /** Best (lowest) 1-based rank of any gold chunk within its own table's BM25
   *  top-40; null if no gold appeared in the BM25 arm. */
  gold_rank_bm25: number | null;
  /** Best (lowest) 1-based rank of any gold chunk within its own table's vector
   *  top-40; null if no gold appeared in the vector arm. */
  gold_rank_vector: number | null;
  /** Distinct candidates actually returned across all arms/tables, keyed
   *  `${table}:${id}` exactly like the pipeline's RRF dedup — the real merged
   *  pool size that fed retrieval for this query. */
  pool_size: number;
  /** Per-gold-id breakdown for auditability (table + per-arm rank). Additive; the
   *  four fields above are the headline. */
  gold_detail: GoldRankDetail[];
  /** Non-null when the vector arm could not be computed (e.g. embed endpoint
   *  unreachable). gold_rank_vector is null in that case and gold_in_pool /
   *  pool_size reflect the BM25 arm ONLY — recorded so a degraded run is never
   *  silently read as "vector missed it". */
  vector_arm_error?: string;
  /** Per-(arm,table) RPC failures (e.g. a slow bm25_budget_indicators tripping
   *  the PostgREST statement timeout). The pipeline itself tolerates these
   *  (returns [] for the table); we record them so a degraded pool is never
   *  silently read as a clean miss. If the entry names a gold's OWN home table,
   *  a gold_in_pool=false for that case is INCONCLUSIVE, not proven blind. */
  arm_errors?: string[];
}

export interface GoldRankDetail {
  chunk_id: string;
  /** Which table's arms this gold id was found in (null if absent from all). */
  table: PoolChunkTable | null;
  rank_bm25: number | null;
  rank_vector: number | null;
}

/**
 * 1-based rank of the FIRST row whose id is in `goldIds`, or null if none of the
 * gold ids appear. Position is the array index the RPC returned — identical to
 * the `idx + 1` the pipeline's rrfMerge assigns as the per-table rank.
 */
export function goldRankInRows(
  rows: readonly PoolRow[],
  goldIds: ReadonlySet<string>,
): number | null {
  for (let i = 0; i < rows.length; i++) {
    if (goldIds.has(rows[i].id)) return i + 1;
  }
  return null;
}

/**
 * Pure aggregation: given the per-table BM25 and vector result rows and the set
 * of expected gold chunk_ids, compute the PoolEcho columns. No network, no DB —
 * this is the logic the tests exercise directly.
 *
 * `bm25ByTable` / `vectorByTable` map each table to the rows that table's arm
 * returned (already ordered by rank). Tables absent from a map are treated as
 * having returned no rows for that arm.
 */
export function summarizePoolEcho(
  goldIds: readonly string[],
  bm25ByTable: ReadonlyMap<PoolChunkTable, readonly PoolRow[]>,
  vectorByTable: ReadonlyMap<PoolChunkTable, readonly PoolRow[]>,
  opts: { vectorArmError?: string; armErrors?: string[] } = {},
): PoolEcho {
  // Per-gold detail: for each gold id, find its table + per-arm in-table rank.
  const detail: GoldRankDetail[] = goldIds.map((chunk_id) => {
    const single = new Set([chunk_id]);
    let table: PoolChunkTable | null = null;
    let rank_bm25: number | null = null;
    let rank_vector: number | null = null;
    for (const t of POOL_CHUNK_TABLES) {
      const b = goldRankInRows(bm25ByTable.get(t) ?? [], single);
      const v = goldRankInRows(vectorByTable.get(t) ?? [], single);
      if (b !== null || v !== null) {
        table = t;
        rank_bm25 = b;
        rank_vector = v;
        break; // ids are globally unique across tables
      }
    }
    return { chunk_id, table, rank_bm25, rank_vector };
  });

  const minOrNull = (xs: (number | null)[]): number | null => {
    const present = xs.filter((x): x is number => x !== null);
    return present.length ? Math.min(...present) : null;
  };
  const gold_rank_bm25 = minOrNull(detail.map((d) => d.rank_bm25));
  const gold_rank_vector = minOrNull(detail.map((d) => d.rank_vector));

  // Merged pool size: distinct `${table}:${id}` across every arm/table, exactly
  // the pipeline's RRF dedup key.
  const merged = new Set<string>();
  for (const t of POOL_CHUNK_TABLES) {
    for (const r of bm25ByTable.get(t) ?? []) merged.add(`${t}:${r.id}`);
    for (const r of vectorByTable.get(t) ?? []) merged.add(`${t}:${r.id}`);
  }

  // gold_in_pool is defined to agree with the per-arm ranks by construction:
  // present in either arm ⇒ in the candidate pool.
  const gold_in_pool = gold_rank_bm25 !== null || gold_rank_vector !== null;

  return {
    gold_in_pool,
    gold_rank_bm25,
    gold_rank_vector,
    pool_size: merged.size,
    gold_detail: detail,
    ...(opts.vectorArmError ? { vector_arm_error: opts.vectorArmError } : {}),
    ...(opts.armErrors && opts.armErrors.length
      ? { arm_errors: opts.armErrors }
      : {}),
  };
}

// ── IO layer (thin; injectable for the runner and the backfill driver) ────────

/** Minimal surface of a supabase-js client used here — just RPC. */
export interface PoolRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/** Call one bm25_<table> RPC with the pipeline's exact argument shape. */
export async function bm25Rows(
  client: PoolRpcClient,
  table: PoolChunkTable,
  query: string,
  limit: number = POOL_CANDIDATE_COUNT,
): Promise<PoolRow[]> {
  const { data, error } = await client.rpc(`bm25_${table}`, {
    p_query_text: query,
    p_limit: limit,
  });
  if (error) throw new Error(`bm25_${table} RPC failed: ${error.message}`);
  return (data ?? []) as PoolRow[];
}

/** Call one match_<table> RPC with the pipeline's exact argument shape. */
export async function vectorRows(
  client: PoolRpcClient,
  table: PoolChunkTable,
  embedding: number[],
  limit: number = POOL_CANDIDATE_COUNT,
): Promise<PoolRow[]> {
  const { data, error } = await client.rpc(`match_${table}`, {
    query_embedding: embedding,
    match_count: limit,
  });
  if (error) throw new Error(`match_${table} RPC failed: ${error.message}`);
  return (data ?? []) as PoolRow[];
}

/**
 * Embed the query via the shipping docling-wrapper /embed path (thenlper/gte-small,
 * mean-pool + L2-normalize — same as the pipeline's Supabase.ai.Session). Returns
 * the 384-d vector, or throws if the endpoint failed / returned a malformed vector.
 */
export async function embedQuery(
  embedUrl: string,
  query: string,
): Promise<number[]> {
  const [vec] = await generateEmbeddingsHttp(embedUrl, [query]);
  if (!vec || vec.length !== 384) {
    throw new Error(
      `embed endpoint returned ${vec ? `${vec.length}-d` : "null"} vector`,
    );
  }
  return vec;
}

/**
 * Run one arm RPC exactly as the pipeline does: a SINGLE call, and on error log
 * and fall back to [] for that table. query-pipeline/index.ts's bm25ForTable /
 * vectorForTable do precisely this (a slow bm25_budget_indicators — 12.9k rows —
 * trips the 8s PostgREST statement timeout under parallel load, and the pipeline
 * simply proceeds with [] for that table). We match that single-call semantics —
 * NOT a retry — so the reconstructed pool matches the pipeline's actual pool,
 * and we ALSO record the failure in `errors` so a hole is never read as a clean
 * miss (if the hole is a gold's OWN home table, gold_in_pool=false is
 * inconclusive, not proven blind).
 */
async function arm(
  fetchRows: () => Promise<PoolRow[]>,
  label: string,
  errors: string[],
): Promise<PoolRow[]> {
  try {
    return await fetchRows();
  } catch (e) {
    errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Full per-case pool echo: fan out BM25 (all 5 tables) and — if an embed URL is
 * given and reachable — vector (all 5 tables), then summarize. Every arm call is
 * per-table resilient (see `arm`): a slow/erroring table degrades to [] and is
 * recorded in `arm_errors`, exactly as the pipeline degrades it, rather than
 * aborting the whole case. The vector arm additionally degrades as a unit if the
 * query cannot be embedded (`vector_arm_error`).
 *
 * `precomputedEmbedding` lets a batch driver embed many queries up front (small
 * capped bursts against the fragile HF Space) and pass the vector in here.
 */
export async function computeCasePoolEcho(
  client: PoolRpcClient,
  query: string,
  goldIds: readonly string[],
  opts: {
    embedUrl?: string;
    precomputedEmbedding?: number[];
    limit?: number;
  } = {},
): Promise<PoolEcho> {
  const limit = opts.limit ?? POOL_CANDIDATE_COUNT;
  const armErrors: string[] = [];

  // Fan out the five tables in PARALLEL per arm — exactly as query-pipeline does
  // (Promise.all over CHUNK_TABLES). Besides matching the pipeline, this keeps a
  // single slow table (e.g. the ~4.5s bm25_budget_indicators) from serializing
  // per-case latency; the whole arm costs max(table), not sum(table).
  const bm25ByTable = new Map<PoolChunkTable, PoolRow[]>();
  await Promise.all(
    POOL_CHUNK_TABLES.map(async (t) => {
      bm25ByTable.set(
        t,
        await arm(() => bm25Rows(client, t, query, limit), `bm25_${t}`, armErrors),
      );
    }),
  );

  const vectorByTable = new Map<PoolChunkTable, PoolRow[]>();
  let vectorArmError: string | undefined;
  try {
    const embedding = opts.precomputedEmbedding ??
      (opts.embedUrl ? await embedQuery(opts.embedUrl, query) : undefined);
    if (!embedding) {
      vectorArmError = "no embedding available (embedUrl/precomputedEmbedding unset)";
    } else {
      await Promise.all(
        POOL_CHUNK_TABLES.map(async (t) => {
          vectorByTable.set(
            t,
            await arm(
              () => vectorRows(client, t, embedding, limit),
              `match_${t}`,
              armErrors,
            ),
          );
        }),
      );
    }
  } catch (err) {
    vectorArmError = err instanceof Error ? err.message : String(err);
  }

  return summarizePoolEcho(goldIds, bm25ByTable, vectorByTable, {
    vectorArmError,
    armErrors,
  });
}
