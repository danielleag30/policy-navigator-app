import {
  EMBED_BATCH_SIZE,
  type EmbeddingWriteDb,
  generateEmbeddings,
  generateEmbeddingsHttp,
  MAX_EMBEDDING_TOKENS,
  persistEmbeddings,
  truncateForEmbedding,
} from "./embedder.ts";
import { estimateTokens } from "./chunker.ts";
import type { AiSession } from "./embedder.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

interface RowConfig {
  delayMs?: number;
  fail?: boolean;
}

/** Fake PostgREST-style db that records writes and lets tests inject per-row delay/failure. */
class FakeEmbeddingDb implements EmbeddingWriteDb {
  updates = new Map<string, number[]>();
  calls: string[] = [];
  concurrentCount = 0;
  maxConcurrent = 0;

  constructor(private rowConfig: Map<string, RowConfig> = new Map()) {}

  from(table: string) {
    return {
      update: (values: Record<string, unknown>) => ({
        eq: async (_column: string, id: string) => {
          this.calls.push(id);
          this.concurrentCount++;
          this.maxConcurrent = Math.max(
            this.maxConcurrent,
            this.concurrentCount,
          );
          try {
            const cfg = this.rowConfig.get(id) ?? {};
            if (cfg.delayMs) {
              await new Promise((resolve) => setTimeout(resolve, cfg.delayMs));
            }
            if (cfg.fail) {
              return {
                error: { message: `simulated failure for ${table}/${id}` },
              };
            }
            this.updates.set(id, values.embedding as number[]);
            return { error: null };
          } finally {
            this.concurrentCount--;
          }
        },
      }),
    };
  }
}

function makeRows(n: number): Array<{ id: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `row-${i}` }));
}

function makeEmbeddings(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => [i]);
}

Deno.test("persistEmbeddings caps concurrent writes at EMBED_BATCH_SIZE", async () => {
  const rowCount = EMBED_BATCH_SIZE * 2 + 5;
  const rows = makeRows(rowCount);
  const embeddings = makeEmbeddings(rowCount);
  const rowConfig = new Map(rows.map((r) => [r.id, { delayMs: 5 }]));
  const db = new FakeEmbeddingDb(rowConfig);

  await persistEmbeddings(db, "some_table", "row", rows, embeddings);

  assertEquals(
    db.maxConcurrent,
    EMBED_BATCH_SIZE,
    "first full batch should reach exactly EMBED_BATCH_SIZE concurrent writes",
  );
  assertEquals(db.calls.length, rowCount);
});

Deno.test("persistEmbeddings writes every row, including across batch boundaries", async () => {
  const rowCount = EMBED_BATCH_SIZE + 3;
  const rows = makeRows(rowCount);
  const embeddings = makeEmbeddings(rowCount);
  const db = new FakeEmbeddingDb();

  await persistEmbeddings(db, "some_table", "row", rows, embeddings);

  assertEquals(db.updates.size, rowCount);
  for (let i = 0; i < rowCount; i++) {
    assertEquals(
      db.updates.get(`row-${i}`),
      [i],
      `row-${i} should have its embedding persisted`,
    );
  }
});

Deno.test("persistEmbeddings skips null embeddings without treating them as a failure", async () => {
  const rows = makeRows(3);
  const embeddings: Array<number[] | null> = [[1], null, [3]];
  const db = new FakeEmbeddingDb();

  await persistEmbeddings(db, "some_table", "row", rows, embeddings);

  assertEquals(db.updates.size, 2);
  assert(
    !db.calls.includes("row-1"),
    "a null embedding should never trigger a DB write",
  );
});

Deno.test("persistEmbeddings: a failure in a later batch does not roll back writes already committed in an earlier batch", async () => {
  const rowCount = EMBED_BATCH_SIZE + 2;
  const rows = makeRows(rowCount);
  const embeddings = makeEmbeddings(rowCount);
  const failingId = `row-${EMBED_BATCH_SIZE}`; // first row of the second batch
  const db = new FakeEmbeddingDb(new Map([[failingId, { fail: true }]]));

  let threw = false;
  try {
    await persistEmbeddings(db, "some_table", "row", rows, embeddings);
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.includes(failingId),
      "rejection should identify the failing row",
    );
  }
  assert(threw, "persistEmbeddings should reject when any write fails");

  for (let i = 0; i < EMBED_BATCH_SIZE; i++) {
    assert(
      db.updates.has(`row-${i}`),
      `row-${i} from the already-completed first batch should remain persisted`,
    );
  }
});

Deno.test("truncateForEmbedding leaves short text untouched", () => {
  const text = "a short provision about zoning setbacks";
  assertEquals(truncateForEmbedding(text), text);
});

Deno.test("truncateForEmbedding shortens text over the token cap", () => {
  const words = Array.from({ length: 2000 }, (_, i) => `word${i}`);
  const text = words.join(" ");
  const truncated = truncateForEmbedding(text);

  assert(
    estimateTokens(truncated) <= MAX_EMBEDDING_TOKENS,
    "truncated text should be at or under the token cap",
  );
  assert(
    truncated.length < text.length,
    "truncated text should be shorter than the original",
  );
  assert(
    text.startsWith(truncated),
    "truncation should keep a leading prefix of the original text",
  );
});

Deno.test("truncateForEmbedding respects a custom maxTokens", () => {
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
  const text = words.join(" ");
  const truncated = truncateForEmbedding(text, 10);

  assert(
    estimateTokens(truncated) <= 10,
    "should honor the smaller custom cap",
  );
});

Deno.test("generateEmbeddings truncates outlier text before calling session.run", async () => {
  const words = Array.from({ length: 20000 }, (_, i) => `word${i}`);
  const hugeText = words.join(" ");
  const seenLengths: number[] = [];
  const session: AiSession = {
    run: (input: string) => {
      seenLengths.push(input.length);
      return Promise.resolve([0]);
    },
  };

  await generateEmbeddings(session, [hugeText]);

  assertEquals(seenLengths.length, 1);
  assert(
    seenLengths[0] < hugeText.length,
    "session.run should receive truncated text, not the full outlier row",
  );
});

/** Installs a fetch stub for the duration of a test; caller must restore in finally. */
function installFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): () => void {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  globalThis.fetch =
    ((url: any, init: any) => handler(String(url), init)) as any;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EMBED_URL = "https://fake-embed.test";

Deno.test("generateEmbeddingsHttp posts to {embedUrl}/embed and returns the response vectors in order", async () => {
  let requestedUrl = "";
  let requestedBody: { texts: string[] } | null = null;
  const restore = installFetch((url, init) => {
    requestedUrl = url;
    requestedBody = JSON.parse(init.body as string);
    return jsonResponse({
      embeddings: [[1, 2], [3, 4]],
      model: "thenlper/gte-small",
      dimensions: 2,
    });
  });

  let result: Array<number[] | null>;
  try {
    result = await generateEmbeddingsHttp(EMBED_URL, ["hello", "world"]);
  } finally {
    restore();
  }

  assertEquals(requestedUrl, `${EMBED_URL}/embed`);
  assertEquals(requestedBody, { texts: ["hello", "world"] });
  assertEquals(result, [[1, 2], [3, 4]]);
});

Deno.test("generateEmbeddingsHttp truncates outlier text before sending", async () => {
  const words = Array.from({ length: 20000 }, (_, i) => `word${i}`);
  const hugeText = words.join(" ");
  let sentLength = 0;
  const restore = installFetch((_url, init) => {
    const { texts } = JSON.parse(init.body as string) as { texts: string[] };
    sentLength = texts[0].length;
    return jsonResponse({
      embeddings: [[0]],
      model: "thenlper/gte-small",
      dimensions: 1,
    });
  });

  try {
    await generateEmbeddingsHttp(EMBED_URL, [hugeText]);
  } finally {
    restore();
  }

  assert(
    sentLength < hugeText.length,
    "the HTTP body should carry truncated text, not the full outlier row",
  );
});

Deno.test("generateEmbeddingsHttp returns nulls (does not throw) on a non-2xx response", async () => {
  const restore = installFetch(() =>
    jsonResponse({ detail: "server error" }, 500)
  );

  let result: Array<number[] | null>;
  try {
    result = await generateEmbeddingsHttp(EMBED_URL, ["a", "b"]);
  } finally {
    restore();
  }

  assertEquals(result, [null, null]);
});

Deno.test("generateEmbeddingsHttp returns nulls on a network error", async () => {
  const restore = installFetch(() => {
    throw new Error("connection refused");
  });

  let result: Array<number[] | null>;
  try {
    result = await generateEmbeddingsHttp(EMBED_URL, ["a"]);
  } finally {
    restore();
  }

  assertEquals(result, [null]);
});

Deno.test("generateEmbeddingsHttp returns nulls on an abort (timeout)", async () => {
  const restore = installFetch((_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  });

  let result: Array<number[] | null>;
  try {
    result = await generateEmbeddingsHttp(EMBED_URL, ["a"], 10);
  } finally {
    restore();
  }

  assertEquals(result, [null]);
});

Deno.test("generateEmbeddingsHttp returns nulls when the response vector count doesn't match the request", async () => {
  const restore = installFetch(() =>
    jsonResponse({
      embeddings: [[1, 2]],
      model: "thenlper/gte-small",
      dimensions: 2,
    })
  );

  let result: Array<number[] | null>;
  try {
    result = await generateEmbeddingsHttp(EMBED_URL, ["a", "b"]);
  } finally {
    restore();
  }

  assertEquals(result, [null, null]);
});

Deno.test("persistEmbeddings: sibling writes in the same batch as a failing row are not lost", async () => {
  const rows = makeRows(3);
  const embeddings = makeEmbeddings(3);
  const db = new FakeEmbeddingDb(new Map([["row-1", { fail: true }]]));

  let threw = false;
  try {
    await persistEmbeddings(db, "some_table", "row", rows, embeddings);
  } catch {
    threw = true;
  }
  assert(threw, "expected persistEmbeddings to reject");

  // Promise.all rejects as soon as one write fails, but it does not cancel the
  // sibling writes already in flight in that same batch — give them a tick to settle.
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert(
    db.updates.has("row-0"),
    "sibling row-0 in the same batch should still be written",
  );
  assert(
    db.updates.has("row-2"),
    "sibling row-2 in the same batch should still be written",
  );
  assert(
    !db.updates.has("row-1"),
    "the failing row itself should have no persisted embedding",
  );
});
