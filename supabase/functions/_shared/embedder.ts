/**
 * Supabase AI Session embedding helpers (task 2-6).
 *
 * Provides pre-flight check and batched embedding generation using the
 * gte-small model (384-dimensional). Each chunk is embedded with one
 * session.run() call; calls are grouped into concurrency batches of 20
 * using Promise.all, with a short pause between groups.
 */

export const EMBED_BATCH_SIZE = 20;
export const EMBED_BATCH_PAUSE_MS = 150;

/** Minimal surface of a PostgREST-style row update needed to persist an embedding. */
export interface EmbeddingWriteDb {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(
        column: string,
        value: string,
      ): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

export interface EmbeddableRow {
  id: string;
}

/** Minimal surface of Supabase.ai.Session used by this module. */
export interface AiSession {
  run(
    input: string,
    options?: { mean_pool?: boolean; normalize?: boolean },
  ): Promise<number[]>;
}

const RUN_OPTS = { mean_pool: true, normalize: true } as const;

/**
 * Run a test embedding to verify the AI Session is reachable and returns
 * a 384-dimensional vector.  Returns false on any error or wrong dimension.
 */
export async function preflight(session: AiSession): Promise<boolean> {
  try {
    const result = await session.run("preflight", RUN_OPTS);
    return Array.isArray(result) && result.length === 384;
  } catch {
    return false;
  }
}

/**
 * Generate embeddings for an array of text strings.
 *
 * Processes texts in groups of EMBED_BATCH_SIZE via Promise.all (one
 * session.run() per text), pausing EMBED_BATCH_PAUSE_MS between groups.
 * Returns a parallel array; null at any index indicates a failed call.
 */
export async function generateEmbeddings(
  session: AiSession,
  texts: string[],
): Promise<Array<number[] | null>> {
  const results: Array<number[] | null> = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (text) => {
        try {
          return await session.run(text, RUN_OPTS);
        } catch {
          return null;
        }
      }),
    );
    results.push(...batchResults);

    if (i + EMBED_BATCH_SIZE < texts.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, EMBED_BATCH_PAUSE_MS));
    }
  }

  return results;
}

/**
 * Persist generated embeddings back onto their source rows.
 *
 * Mirrors generateEmbeddings' concurrency shape: writes are grouped into
 * batches of EMBED_BATCH_SIZE via Promise.all, with a short pause between
 * groups, instead of firing one concurrent request per row. A null embedding
 * at a given index is logged and skipped (not treated as a failure, matching
 * the previous per-row behavior). A DB error on any write rejects the call;
 * rows in batches that already completed remain persisted, so a failure part
 * way through does not lose or roll back prior writes.
 */
export async function persistEmbeddings<T extends EmbeddableRow>(
  db: EmbeddingWriteDb,
  table: string,
  label: string,
  rows: T[],
  embeddings: Array<number[] | null>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
    const batchRows = rows.slice(i, i + EMBED_BATCH_SIZE);
    const batchEmbeddings = embeddings.slice(i, i + EMBED_BATCH_SIZE);

    await Promise.all(
      batchRows.map((row, j) => {
        const emb = batchEmbeddings[j];
        if (emb === null) {
          console.error(`[embedder] null embedding for ${label} ${row.id}`);
          return Promise.resolve();
        }
        return db
          .from(table)
          .update({ embedding: emb, updated_at: new Date().toISOString() })
          .eq("id", row.id)
          .then(({ error }) => {
            if (error) {
              throw new Error(
                `Failed to persist embedding for ${label} ${row.id}: ${error.message}`,
              );
            }
          });
      }),
    );

    if (i + EMBED_BATCH_SIZE < rows.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, EMBED_BATCH_PAUSE_MS));
    }
  }
}
