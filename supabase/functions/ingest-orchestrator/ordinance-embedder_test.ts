/**
 * NOTE on coverage limits: every session.run() below is a fake that resolves
 * immediately with a fixed vector. These tests validate wiring -- fetch
 * paging, the keyset cursor, per-row deadline checks, resume behavior -- not
 * real CPU cost. The WORKER_RESOURCE_LIMIT crash this module's sequential
 * design works around only reproduces against real gte-small inference on
 * real ordinance content; it was confirmed by live invocation against the
 * production backlog, not by a unit test, and no fake session here can catch
 * a regression back toward concurrent embedding calls.
 */
import type { AiSession } from "../_shared/embedder.ts";
import {
  embedOrdinanceProvisionsBatched,
  type OrdinanceEmbedDb,
  type OrdinanceProvisionRow,
} from "./ordinance-embedder.ts";

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

const DOC_ID = "018f4d8a-8a46-7c46-9c46-2a9f688f1d3a";

/** id-sortable fake id so ascending order is deterministic, like a real uuidv7. */
function id(n: number): string {
  return `row-${String(n).padStart(4, "0")}`;
}

interface FakeRow extends OrdinanceProvisionRow {
  document_id: string;
  is_current: boolean;
  embedding: number[] | null;
}

/**
 * Fake ordinance_provisions table backing the paged fetch, the update writes
 * (persistEmbeddings), and the final null-count verification query. Untyped
 * internally to keep the chain builders simple; cast to OrdinanceEmbedDb at
 * the call site since it satisfies that shape structurally.
 */
class FakeOrdinanceDb {
  fetchCalls: Array<{ cursor: string; limit: number }> = [];
  updateCalls: string[] = [];
  countCalls = 0;

  constructor(private rows: FakeRow[]) {}

  from(_table: string) {
    const self = this;
    return {
      select(_columns: string, opts?: { count: "exact"; head: true }) {
        if (opts) {
          return {
            eq(_c1: string, docId: string) {
              return {
                eq(_c2: string, _isCurrent: boolean) {
                  return {
                    is(_c3: string, _v: null) {
                      self.countCalls++;
                      const count = self.rows.filter(
                        (r) =>
                          r.document_id === docId && r.is_current &&
                          r.embedding === null,
                      ).length;
                      return Promise.resolve({ count, error: null });
                    },
                  };
                },
              };
            },
          };
        }

        return {
          eq(_c1: string, docId: string) {
            return {
              eq(_c2: string, _isCurrent: boolean) {
                return {
                  is(_c3: string, _v: null) {
                    return {
                      gt(_c4: string, cursor: string) {
                        return {
                          order(_c5: string) {
                            return {
                              limit(n: number) {
                                self.fetchCalls.push({ cursor, limit: n });
                                const matching = self.rows
                                  .filter((r) =>
                                    r.document_id === docId &&
                                    r.is_current &&
                                    r.embedding === null &&
                                    r.id > cursor
                                  )
                                  .sort((a, b) => a.id.localeCompare(b.id))
                                  .slice(0, n)
                                  .map(({ id, content }) => ({ id, content }));
                                return Promise.resolve({
                                  data: matching,
                                  error: null,
                                });
                              },
                            };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      update(values: Record<string, unknown>) {
        return {
          eq(_column: string, rowId: string) {
            self.updateCalls.push(rowId);
            const row = self.rows.find((r) => r.id === rowId);
            if (row) row.embedding = values.embedding as number[];
            return Promise.resolve({ error: null });
          },
        };
      },
    };
  }
}

function asDb(fake: FakeOrdinanceDb): OrdinanceEmbedDb {
  return fake as unknown as OrdinanceEmbedDb;
}

function makeRow(n: number, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: id(n),
    document_id: DOC_ID,
    content: `provision content ${n}`,
    is_current: true,
    embedding: null,
    ...overrides,
  };
}

function countingSession(): AiSession & { calls: number } {
  return {
    calls: 0,
    run(_input: string) {
      this.calls++;
      return Promise.resolve([1, 2, 3]);
    },
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.test("initial fetch uses a syntactically valid uuid cursor, not an empty string", async () => {
  // Regression test: id is a `uuid` column in Postgres, so an empty-string
  // cursor on the first page fails with "invalid input syntax for type uuid"
  // once this hits real Postgres (a fake string-keyed DB can't catch this).
  const rows: FakeRow[] = [makeRow(1)];
  const fake = new FakeOrdinanceDb(rows);
  const session = countingSession();

  await embedOrdinanceProvisionsBatched(asDb(fake), session, DOC_ID);

  assert(fake.fetchCalls.length > 0, "expected at least one fetch call");
  assert(
    UUID_RE.test(fake.fetchCalls[0].cursor),
    `initial cursor must be a valid uuid literal, got ${
      JSON.stringify(fake.fetchCalls[0].cursor)
    }`,
  );
});

Deno.test("embeds only current rows, skipping superseded ones", async () => {
  const rows: FakeRow[] = [
    makeRow(1),
    makeRow(2, { is_current: false }),
    makeRow(3),
  ];
  const fake = new FakeOrdinanceDb(rows);
  const session = countingSession();

  const { processed, complete } = await embedOrdinanceProvisionsBatched(
    asDb(fake),
    session,
    DOC_ID,
  );

  assertEquals(processed, 2);
  assertEquals(complete, true);
  assertEquals(session.calls, 2);
  assert(
    !fake.updateCalls.includes(id(2)),
    "superseded row should never be embedded",
  );
  assert(
    rows[1].embedding === null,
    "superseded row's embedding should remain null",
  );
  assertEquals(rows[0].embedding, [1, 2, 3]);
  assertEquals(rows[2].embedding, [1, 2, 3]);
});

Deno.test("skips rows that already have an embedding from a prior partial run", async () => {
  const rows: FakeRow[] = [
    makeRow(1, { embedding: [9, 9, 9] }),
    makeRow(2),
  ];
  const fake = new FakeOrdinanceDb(rows);
  const session = countingSession();

  const { processed, complete } = await embedOrdinanceProvisionsBatched(
    asDb(fake),
    session,
    DOC_ID,
  );

  assertEquals(processed, 1);
  assertEquals(complete, true);
  assertEquals(session.calls, 1);
  assert(
    !fake.updateCalls.includes(id(1)),
    "already-embedded row should not be re-fetched or rewritten",
  );
  assertEquals(
    rows[0].embedding,
    [9, 9, 9],
    "pre-existing embedding should be untouched",
  );
});

Deno.test("pages through more rows than fit in a single batch", async () => {
  const batchSize = 5;
  const rowCount = batchSize * 3 + 2; // forces 4 fetch pages
  const rows: FakeRow[] = Array.from(
    { length: rowCount },
    (_, i) => makeRow(i),
  );
  const fake = new FakeOrdinanceDb(rows);
  const session = countingSession();

  const { processed, complete } = await embedOrdinanceProvisionsBatched(
    asDb(fake),
    session,
    DOC_ID,
    batchSize,
  );

  assertEquals(processed, rowCount);
  assertEquals(complete, true);
  assertEquals(session.calls, rowCount);
  assert(
    fake.fetchCalls.length >= 4,
    "should have paged across multiple fetch calls",
  );
  for (const row of rows) {
    assertEquals(row.embedding, [1, 2, 3]);
  }
});

Deno.test("embeds one row fully (embed + persist) before starting the next, even within a single fetched page", async () => {
  // Regression test for the CPU-budget fix: a prior design called
  // generateEmbeddings/session.run() concurrently (via Promise.all) across an
  // entire fetched page, which is exactly what exhausted the Edge Function
  // CPU ceiling against real content. This asserts the row-processing order
  // is strictly interleaved embed-then-persist-then-next-embed, never two
  // session.run() calls in flight at once.
  const batchSize = 4;
  const rows: FakeRow[] = Array.from(
    { length: batchSize },
    (_, i) => makeRow(i),
  );
  const fake = new FakeOrdinanceDb(rows);

  const events: string[] = [];
  let inFlight = 0;
  const trackingSession: AiSession = {
    async run(_input: string) {
      inFlight++;
      assertEquals(
        inFlight,
        1,
        "session.run() must never overlap with another in-flight call",
      );
      events.push("embed-start");
      await Promise.resolve(); // yield, so a concurrent implementation would interleave here
      events.push("embed-end");
      inFlight--;
      return [1, 2, 3];
    },
  };
  const originalUpdate = fake.updateCalls.push.bind(fake.updateCalls);
  fake.updateCalls.push = (...ids: string[]) => {
    events.push("persist");
    return originalUpdate(...ids);
  };

  const { processed, complete } = await embedOrdinanceProvisionsBatched(
    asDb(fake),
    trackingSession,
    DOC_ID,
    batchSize,
  );

  assertEquals(processed, batchSize);
  assertEquals(complete, true);
  const expectedEvents = Array.from(
    { length: batchSize },
    () => ["embed-start", "embed-end", "persist"],
  ).flat();
  assertEquals(
    events,
    expectedEvents,
    "each row's embed must fully complete (and persist) before the next row's embed starts",
  );
});

Deno.test("advances the cursor past a row even if its embedding fails, avoiding an infinite loop", async () => {
  const rows: FakeRow[] = [makeRow(1), makeRow(2), makeRow(3)];
  const fake = new FakeOrdinanceDb(rows);
  let calls = 0;
  const failingSession: AiSession = {
    run(_input: string) {
      calls++;
      // First row (id-0001) always fails to embed.
      if (calls === 1) return Promise.reject(new Error("model unavailable"));
      return Promise.resolve([1, 2, 3]);
    },
  };

  let threw = false;
  try {
    await embedOrdinanceProvisionsBatched(
      asDb(fake),
      failingSession,
      DOC_ID,
      1,
    );
  } catch {
    threw = true;
  }

  assert(
    threw,
    "a permanently null embedding should surface as a final error, not loop forever",
  );
  assertEquals(rows[0].embedding, null);
  assertEquals(rows[1].embedding, [1, 2, 3]);
  assertEquals(rows[2].embedding, [1, 2, 3]);
});

Deno.test("no-op when there are no ordinance_provisions rows for the document", async () => {
  const fake = new FakeOrdinanceDb([]);
  const session = countingSession();

  const { processed, complete } = await embedOrdinanceProvisionsBatched(
    asDb(fake),
    session,
    DOC_ID,
  );

  assertEquals(processed, 0);
  assertEquals(complete, true);
  assertEquals(session.calls, 0);
  assertEquals(
    fake.countCalls,
    0,
    "should skip the final verification query when nothing was processed",
  );
});

Deno.test("fetches document-scoped rows only, never leaking another document's provisions", async () => {
  const otherDocId = "018f4d8a-8a46-7c46-9c46-2a9f688f1d3b";
  const rows: FakeRow[] = [
    makeRow(1),
    makeRow(2, { document_id: otherDocId }),
  ];
  const fake = new FakeOrdinanceDb(rows);
  const session = countingSession();

  const { processed, complete } = await embedOrdinanceProvisionsBatched(
    asDb(fake),
    session,
    DOC_ID,
  );

  assertEquals(processed, 1);
  assertEquals(complete, true);
  assertEquals(
    rows[1].embedding,
    null,
    "other document's row should be untouched",
  );
});

Deno.test("returns complete: false and stops early once the soft deadline is exceeded mid-backlog, without throwing", async () => {
  const batchSize = 2;
  const rowCount = batchSize * 3; // three full pages available
  const rows: FakeRow[] = Array.from(
    { length: rowCount },
    (_, i) => makeRow(i),
  );
  const fake = new FakeOrdinanceDb(rows);
  const session = countingSession();

  // softDeadlineMs = 0: the deadline is checked after every row (not just
  // after a full page), so the very first row's post-embed check (elapsed
  // >= 0) trips -- exactly one row should be processed before the function
  // returns.
  const { processed, complete } = await embedOrdinanceProvisionsBatched(
    asDb(fake),
    session,
    DOC_ID,
    batchSize,
    0,
  );

  assertEquals(processed, 1);
  assertEquals(complete, false);
  assertEquals(fake.fetchCalls.length, 1, "should stop within the first page");
  assertEquals(
    fake.countCalls,
    0,
    "should skip the final verification query on a deadline-triggered return",
  );
  assertEquals(rows[0].embedding, [1, 2, 3]);
  assertEquals(
    rows[1].embedding,
    null,
    "rows after the first should be untouched this invocation",
  );
  assertEquals(
    rows[2].embedding,
    null,
    "rows beyond the first page should be untouched this invocation",
  );
});

Deno.test("a subsequent call after a deadline-triggered partial run resumes without re-processing already-embedded rows", async () => {
  const batchSize = 2;
  const rowCount = batchSize * 3 + 1; // 7 rows, uneven w.r.t. batchSize
  const rows: FakeRow[] = Array.from(
    { length: rowCount },
    (_, i) => makeRow(i),
  );
  const fake = new FakeOrdinanceDb(rows);
  const session = countingSession();

  // Invocation 1: deadline trips immediately after the first row.
  const first = await embedOrdinanceProvisionsBatched(
    asDb(fake),
    session,
    DOC_ID,
    batchSize,
    0,
  );
  assertEquals(first.processed, 1);
  assertEquals(first.complete, false);

  // Invocation 2 (simulating the next cron tick): default/generous deadline,
  // same fake DB instance carrying forward the embeddings persisted above.
  const second = await embedOrdinanceProvisionsBatched(
    asDb(fake),
    session,
    DOC_ID,
    batchSize,
  );
  assertEquals(second.processed, rowCount - 1);
  assertEquals(second.complete, true);

  // Every row embedded exactly once in total, no throws, no crash.
  assertEquals(session.calls, rowCount);
  for (const row of rows) {
    assertEquals(row.embedding, [1, 2, 3]);
  }
  // Invocation 2 starts its own fresh cursor (no persisted resume state) and
  // relies solely on the embedding-IS-NULL filter to skip invocation 1's rows.
  const MIN_UUID = "00000000-0000-0000-0000-000000000000";
  assertEquals(
    fake.fetchCalls[1].cursor,
    MIN_UUID,
    "invocation 2's first fetch should start from a fresh cursor, not a persisted one",
  );
});
