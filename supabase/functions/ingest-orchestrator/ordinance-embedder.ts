/**
 * Batched embedding pass for ordinance_provisions (task 2-6).
 *
 * ordinance_provisions is a versioned table — a single Municode document can
 * accumulate thousands of rows across superseded and current versions (2,722+
 * observed in production). Unlike the other embed* helpers in index.ts, this
 * cannot fetch the whole document's rows into memory before generating any
 * embeddings: that both re-embeds superseded (is_current = false) rows that
 * are never queried, and holds the entire text set (including multi-KB
 * outlier rows) in memory at once.
 *
 * Instead this fetches only current, not-yet-embedded rows, one
 * EMBED_BATCH_SIZE page at a time, and generates + persists each page before
 * fetching the next. A stable id keyset cursor (rather than OFFSET-style
 * paging) is used to advance so that already-attempted rows are never
 * refetched even if their embedding failed to generate.
 */

import {
  type AiSession,
  type EmbeddableRow,
  type EmbeddingWriteDb,
  generateEmbeddings,
  persistEmbeddings,
} from "../_shared/embedder.ts";

/**
 * Row-fetch/embed concurrency for this path only. Supabase Edge Functions cap
 * CPU time at ~2s per invocation on every plan (free and paid alike), and
 * gte-small inference via Supabase.ai.Session.run() is synchronous CPU-bound
 * compute that counts fully against that budget -- generateEmbeddings' default
 * EMBED_BATCH_SIZE (20) concurrent session.run() calls is enough on its own to
 * exhaust it before a single row is persisted, crashing the invocation with
 * WORKER_RESOURCE_LIMIT. This constant is intentionally local to the
 * ordinance_provisions path -- embedNarrativeChunks/embedBudgetIndicators in
 * index.ts are not exhibiting this problem, so EMBED_BATCH_SIZE itself is
 * left untouched.
 */
export const ORDINANCE_EMBED_CHUNK_SIZE = 3;

/**
 * Wall-clock budget for this function's own batching loop, independent of the
 * outer ~120s SOFT_DEADLINE_MS used elsewhere in index.ts. This is
 * deliberately tight: given the current per-chunk CPU cost, at most one chunk
 * will typically complete before this trips. It exists so that, if the
 * CPU-cost problem above is fixed independently, more chunks simply start
 * fitting under this same budget with no code change here -- it is not itself
 * a fix for the CPU ceiling.
 */
export const ORDINANCE_EMBED_SOFT_DEADLINE_MS = 1_500;

export interface OrdinanceProvisionRow extends EmbeddableRow {
  content: string;
}

/** Minimal surface of the ordinance_provisions query chains this module needs. */
export interface OrdinanceEmbedDb extends EmbeddingWriteDb {
  from(table: "ordinance_provisions"): {
    select(columns: "id, content"): {
      eq(column: "document_id", value: string): {
        eq(column: "is_current", value: true): {
          is(column: "embedding", value: null): {
            gt(column: "id", value: string): {
              order(column: "id"): {
                limit(n: number): PromiseLike<{
                  data: OrdinanceProvisionRow[] | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      };
    };
    select(
      columns: "id",
      opts: { count: "exact"; head: true },
    ): {
      eq(column: "document_id", value: string): {
        eq(column: "is_current", value: true): {
          is(
            column: "embedding",
            value: null,
          ): PromiseLike<
            { count: number | null; error: { message: string } | null }
          >;
        };
      };
    };
    update(values: Record<string, unknown>): {
      eq(
        column: string,
        value: string,
      ): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/** Minimum possible uuid value — a safe "start of keyset" sentinel for the id cursor below. */
const MIN_UUID = "00000000-0000-0000-0000-000000000000";

export interface OrdinanceEmbedResult {
  /** Rows attempted (whether or not their embedding call ultimately succeeded) this invocation. */
  processed: number;
  /** false when the soft deadline was hit mid-backlog; the remaining rows resume on the next invocation. */
  complete: boolean;
}

/**
 * Fetch, embed, and persist ordinance_provisions for a document in aligned
 * batches, stopping early (without throwing) if the soft deadline is hit
 * mid-backlog. Safe to call again on the next invocation: the
 * is_current=true AND embedding IS NULL filter plus the keyset cursor mean an
 * already-embedded row is never refetched or reprocessed.
 */
export async function embedOrdinanceProvisionsBatched(
  db: OrdinanceEmbedDb,
  session: AiSession,
  documentId: string,
  batchSize: number = ORDINANCE_EMBED_CHUNK_SIZE,
  softDeadlineMs: number = ORDINANCE_EMBED_SOFT_DEADLINE_MS,
): Promise<OrdinanceEmbedResult> {
  const startMs = Date.now();
  let cursor = MIN_UUID;
  let processed = 0;

  while (true) {
    const { data: rows, error: fetchErr } = await db
      .from("ordinance_provisions")
      .select("id, content")
      .eq("document_id", documentId)
      .eq("is_current", true)
      .is("embedding", null)
      .gt("id", cursor)
      .order("id")
      .limit(batchSize);

    if (fetchErr) {
      throw new Error(
        `Fetching ordinance_provisions failed: ${fetchErr.message}`,
      );
    }
    if (!rows || rows.length === 0) break;

    const texts = rows.map((r) => r.content);
    const embeddings = await generateEmbeddings(session, texts);
    await persistEmbeddings(
      db,
      "ordinance_provisions",
      "provision",
      rows,
      embeddings,
    );

    processed += rows.length;
    cursor = rows[rows.length - 1].id;

    if (Date.now() - startMs >= softDeadlineMs) {
      console.warn(
        `[embedder] ordinance_provisions soft deadline hit after ${processed} row(s) for document ${documentId} -- resuming next invocation`,
      );
      return { processed, complete: false };
    }
  }

  if (processed === 0) {
    console.log(
      `[embedder] no ordinance_provisions to embed for document ${documentId}`,
    );
    return { processed: 0, complete: true };
  }

  // DB-side re-verification: no current provision should be missing an embedding.
  // Only reached on a natural drain (loop broke on an empty page) -- a
  // deadline-triggered return above always exits before this point, since a
  // partial run leaving nulls behind is expected, not a failure.
  const { count, error: countErr } = await db
    .from("ordinance_provisions")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("is_current", true)
    .is("embedding", null);

  if (countErr) {
    throw new Error(
      `Null-check query failed for ordinance_provisions: ${countErr.message}`,
    );
  }
  if (count && count > 0) {
    throw new Error(
      `${count} current ordinance_provisions still have null embedding after generation`,
    );
  }

  return { processed, complete: true };
}
