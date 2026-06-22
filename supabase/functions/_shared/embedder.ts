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
