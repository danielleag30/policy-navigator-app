/**
 * Sequential embedding pass for ordinance_provisions (task 2-6).
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
 * ORDINANCE_EMBED_FETCH_PAGE_SIZE page at a time, and embeds + persists rows
 * one at a time within each page, checking the soft deadline after every row.
 * A stable id keyset cursor (rather than OFFSET-style paging) is used to
 * advance so that already-attempted rows are never refetched even if their
 * embedding failed to generate.
 *
 * Embedding generation itself was originally an in-process
 * Supabase.ai.Session('gte-small').run() call. Live invocation against the
 * real production backlog (2,676 stuck rows, real Fairfax County ordinance
 * content) confirmed even 3-way *concurrent* session.run() calls reliably
 * exhausted the ~2s Edge Function CPU-time ceiling before a single row was
 * persisted, crashing with WORKER_RESOURCE_LIMIT -- CPU time, not wall clock,
 * was the binding constraint. That ceiling only counts CPU-bound work, so
 * embedding generation now runs as an HTTP call to the docling-wrapper HF
 * Space's POST /embed (see _shared/embedder.ts generateEmbeddingsHttp) --
 * awaiting a fetch is I/O, exempt from the CPU budget, which removes the
 * constraint that throttled this path to 1-3 rows per invocation.
 *
 * The one-row-at-a-time sequential loop is kept regardless: the HF Space runs
 * a single Uvicorn worker (see docling-wrapper/CONTRACT.md), so concurrent
 * /embed requests would just queue server-side, and there's no reason to
 * reintroduce the concurrency this module was written to eliminate.
 */

import {
  type EmbeddableRow,
  type EmbeddingWriteDb,
  generateEmbeddingsHttp,
  persistEmbeddings,
} from "../_shared/embedder.ts";

/**
 * Rows fetched per DB round trip for this path. Embedding is strictly
 * sequential (see embedOrdinanceProvisionsBatched below) -- this only
 * controls how many not-yet-embedded rows are pulled per query, not how many
 * are embedded at once. Kept local to the ordinance_provisions path --
 * embedNarrativeChunks/embedBudgetIndicators in index.ts are not exhibiting
 * the CPU-budget problem this module works around, so EMBED_BATCH_SIZE
 * itself is left untouched.
 */
export const ORDINANCE_EMBED_FETCH_PAGE_SIZE = 3;

/**
 * Fallback wall-clock budget for this function's own batching loop, used
 * only when the caller doesn't pass an explicit softDeadlineMs. index.ts
 * passes the actual remaining time until the invocation's own SOFT_DEADLINE_MS
 * (itself well under the ~150s Edge Function wall-clock hard kill), so this
 * default only matters for direct/test callers. Checked after every
 * individual row's embed+persist, not just after a full fetched page, so a
 * slow /embed call mid-page still stops promptly rather than overrunning.
 */
export const ORDINANCE_EMBED_SOFT_DEADLINE_MS = 60_000;

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
 * Fetch, embed, and persist ordinance_provisions for a document one row at a
 * time, stopping early (without throwing) if the soft deadline is hit
 * mid-backlog. Safe to call again on the next invocation: the
 * is_current=true AND embedding IS NULL filter plus the keyset cursor mean an
 * already-embedded row is never refetched or reprocessed.
 *
 * embedUrl is the docling-wrapper HF Space's base URL (HF_SPACES_DOCLING_URL)
 * -- the same Space already used for Docling PDF conversion also serves
 * POST /embed.
 */
export async function embedOrdinanceProvisionsBatched(
  db: OrdinanceEmbedDb,
  embedUrl: string,
  documentId: string,
  batchSize: number = ORDINANCE_EMBED_FETCH_PAGE_SIZE,
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

    for (const row of rows) {
      const [embedding] = await generateEmbeddingsHttp(embedUrl, [row.content]);
      await persistEmbeddings(
        db,
        "ordinance_provisions",
        "provision",
        [row],
        [embedding],
      );

      processed += 1;
      cursor = row.id;

      if (Date.now() - startMs >= softDeadlineMs) {
        console.warn(
          `[embedder] ordinance_provisions soft deadline hit after ${processed} row(s) for document ${documentId} -- resuming next invocation`,
        );
        return { processed, complete: false };
      }
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
