/**
 * Unit tests for the encode-reprint-preingest resumable OCR job.
 *
 * Run with: deno test --allow-env supabase/functions/encode-reprint-preingest/_preingest_test.ts
 */

import {
  claimReprint,
  type EncodeReprintDb,
  type EncodeReprintPreingestDeps,
  ensureStateRows,
  type FetchOcrChunk,
  type FetchPageCount,
  groupBlocksIntoPageRows,
  listIncompleteReprints,
  type PreingestStateRow,
  processOneReprint,
  runEncodeReprintPreingest,
} from "./_preingest.ts";
import { ENCODE_ZONING_REPRINTS } from "../_shared/encode-zoning-reprints.ts";
import type { FlatBlock } from "../_shared/chunker.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

function withEncodeGate(value: string | undefined, fn: () => Promise<void>) {
  const previous = Deno.env.get("ENCODE_ZONING_ENABLED");
  if (value === undefined) Deno.env.delete("ENCODE_ZONING_ENABLED");
  else Deno.env.set("ENCODE_ZONING_ENABLED", value);
  return fn().finally(() => {
    if (previous === undefined) Deno.env.delete("ENCODE_ZONING_ENABLED");
    else Deno.env.set("ENCODE_ZONING_ENABLED", previous);
  });
}

// ── In-memory fake EncodeReprintDb ───────────────────────────────────────────
//
// Implements the same narrow chainable shape claimReprint/persistState/
// listIncompleteReprints/ensureStateRows/upsertPages actually call, backed
// by real in-memory Maps — so tests genuinely exercise the atomic-claim
// semantics (a claim only succeeds when claim_expires_at is null or in the
// past) and the resume cursor (next_page/pages_completed persisted exactly
// as the real update payloads would), not a canned response.

interface FakePageRow {
  id: string;
  doc_library_id: string;
  page_number: number;
  text: string;
}

function createFakeDb() {
  const state = new Map<string, PreingestStateRow>();
  const pages = new Map<string, FakePageRow>();

  function stateTable() {
    return {
      upsert(
        rows: Record<string, unknown>[],
        _opts: { onConflict: string; ignoreDuplicates?: boolean },
      ) {
        for (const row of rows) {
          const id = row.doc_library_id as string;
          if (state.has(id)) continue;
          state.set(id, {
            doc_library_id: id,
            reprint_label: row.reprint_label as string,
            reprint_year: row.reprint_year as number,
            status: "pending",
            total_pages: null,
            next_page: 1,
            pages_completed: 0,
            claim_expires_at: null,
            last_invoked_at: new Date(0).toISOString(),
            last_error: null,
            completed_at: null,
          });
        }
        return Promise.resolve({ error: null });
      },
      update(patch: Record<string, unknown>) {
        let eqId: string | undefined;
        let orCond: string | undefined;
        const chain = {
          eq(_column: string, value: string) {
            eqId = value;
            return chain;
          },
          or(cond: string) {
            orCond = cond;
            return chain;
          },
          select(_columns: string) {
            return {
              maybeSingle: () => {
                if (!eqId) throw new Error("update() called without .eq()");
                const row = state.get(eqId);
                if (!row) return Promise.resolve({ data: null, error: null });
                if (orCond) {
                  const ltMatch = orCond.match(/claim_expires_at\.lt\.(.+)$/);
                  const cutoff = ltMatch
                    ? ltMatch[1]
                    : new Date().toISOString();
                  const eligible = row.claim_expires_at === null ||
                    row.claim_expires_at < cutoff;
                  if (!eligible) {
                    return Promise.resolve({ data: null, error: null });
                  }
                }
                Object.assign(row, patch);
                return Promise.resolve({ data: { ...row }, error: null });
              },
            };
          },
        };
        return chain;
      },
      select(_columns: string) {
        return {
          neq(_column: string, value: string) {
            return {
              order(_column2: string, opts: { ascending: boolean }) {
                const rows = [...state.values()].filter((r) =>
                  r.status !== value
                );
                rows.sort((a, b) =>
                  opts.ascending
                    ? a.last_invoked_at.localeCompare(b.last_invoked_at)
                    : b.last_invoked_at.localeCompare(a.last_invoked_at)
                );
                return Promise.resolve({
                  data: rows.map((r) => ({ ...r })),
                  error: null,
                });
              },
            };
          },
        };
      },
    };
  }

  function pagesTable() {
    return {
      upsert(
        rows: Record<string, unknown>[],
        _opts: { onConflict: string },
      ) {
        for (const row of rows) {
          const key = `${row.doc_library_id}:${row.page_number}`;
          pages.set(key, row as unknown as FakePageRow);
        }
        return Promise.resolve({ error: null });
      },
    };
  }

  function from(table: string) {
    if (table === "encode_reprint_preingest_state") return stateTable();
    if (table === "encode_reprint_pages") return pagesTable();
    throw new Error(`createFakeDb: unexpected table ${table}`);
  }

  // deno-lint-ignore no-explicit-any
  const db = { from } as any as EncodeReprintDb;
  return { db, state, pages };
}

function makeClaimedRow(
  overrides: Partial<PreingestStateRow> = {},
): PreingestStateRow {
  return {
    doc_library_id: "test-doc-1",
    reprint_label: "Test Reprint",
    reprint_year: 1950,
    status: "in_progress",
    total_pages: null,
    next_page: 1,
    pages_completed: 0,
    claim_expires_at: null,
    last_invoked_at: new Date(0).toISOString(),
    last_error: null,
    completed_at: null,
    ...overrides,
  };
}

/** Deterministic fetchOcrChunk: one block per requested page, page_no set. */
function makeFetchOcrChunk(
  opts: {
    blankPages?: Set<number>;
    onCall?: (start: number, end: number) => void;
  } = {},
): FetchOcrChunk {
  return (_url: string, pageStart: number, pageEnd: number) => {
    opts.onCall?.(pageStart, pageEnd);
    const blocks: FlatBlock[] = [];
    for (let p = pageStart; p <= pageEnd; p++) {
      if (opts.blankPages?.has(p)) continue; // simulate a genuinely blank scanned page
      blocks.push({
        text: `Page ${p} content.`,
        page_no: p,
        bbox: null,
        reading_order_index: p,
      });
    }
    return Promise.resolve(blocks);
  };
}

// ── groupBlocksIntoPageRows ──────────────────────────────────────────────────

Deno.test("groupBlocksIntoPageRows joins multiple blocks on the same page in reading order", () => {
  const blocks: FlatBlock[] = [
    {
      text: "Second sentence.",
      page_no: 5,
      bbox: null,
      reading_order_index: 1,
    },
    { text: "First sentence.", page_no: 5, bbox: null, reading_order_index: 0 },
  ];
  const rows = groupBlocksIntoPageRows(blocks);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].page_number, 5);
  assertEquals(rows[0].text, "First sentence. Second sentence.");
});

Deno.test("groupBlocksIntoPageRows drops pages with no extractable text (blank scanned page)", () => {
  const blocks: FlatBlock[] = [
    { text: "", page_no: 6, bbox: null, reading_order_index: 0 },
    { text: "  ", page_no: 7, bbox: null, reading_order_index: 1 },
    { text: "Real content.", page_no: 8, bbox: null, reading_order_index: 2 },
  ];
  const rows = groupBlocksIntoPageRows(blocks);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].page_number, 8);
});

Deno.test("groupBlocksIntoPageRows drops blocks with a null page_no", () => {
  const blocks: FlatBlock[] = [
    { text: "Orphan text.", page_no: null, bbox: null, reading_order_index: 0 },
  ];
  assertEquals(groupBlocksIntoPageRows(blocks), []);
});

Deno.test("groupBlocksIntoPageRows returns pages sorted ascending by page number", () => {
  const blocks: FlatBlock[] = [
    { text: "Page nine.", page_no: 9, bbox: null, reading_order_index: 0 },
    { text: "Page three.", page_no: 3, bbox: null, reading_order_index: 1 },
  ];
  const rows = groupBlocksIntoPageRows(blocks);
  assertEquals(rows.map((r) => r.page_number), [3, 9]);
});

// ── claimReprint (atomic lease) ──────────────────────────────────────────────

Deno.test("claimReprint claims an unclaimed row and sets a lease", async () => {
  const { db, state } = createFakeDb();
  state.set(
    "doc-a",
    makeClaimedRow({ doc_library_id: "doc-a", status: "pending" }),
  );

  const nowMs = () => 1_000_000;
  const claimed = await claimReprint(db, "doc-a", {
    nowMs,
    nowIso: () => "T0",
  });
  assert(claimed !== null, "expected the claim to succeed");
  assertEquals(claimed!.status, "in_progress");
  assertEquals(state.get("doc-a")!.claim_expires_at !== null, true);
});

Deno.test("claimReprint returns null when another invocation already holds an unexpired lease", async () => {
  const { db, state } = createFakeDb();
  const futureLease = new Date(Date.now() + 60_000).toISOString();
  state.set(
    "doc-a",
    makeClaimedRow({ doc_library_id: "doc-a", claim_expires_at: futureLease }),
  );

  const claimed = await claimReprint(db, "doc-a", {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  });
  assertEquals(claimed, null);
});

Deno.test("claimReprint succeeds once a prior lease has expired", async () => {
  const { db, state } = createFakeDb();
  const expiredLease = new Date(Date.now() - 60_000).toISOString();
  state.set(
    "doc-a",
    makeClaimedRow({ doc_library_id: "doc-a", claim_expires_at: expiredLease }),
  );

  const claimed = await claimReprint(db, "doc-a", {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  });
  assert(
    claimed !== null,
    "expected the claim to succeed once the lease expired",
  );
});

// ── ensureStateRows / listIncompleteReprints ─────────────────────────────────

Deno.test("ensureStateRows seeds exactly one row per ENCODE_ZONING_REPRINTS entry, idempotently", async () => {
  const { db, state } = createFakeDb();
  await ensureStateRows(db);
  assertEquals(state.size, ENCODE_ZONING_REPRINTS.length);
  for (const reprint of ENCODE_ZONING_REPRINTS) {
    assert(
      state.has(reprint.docLibraryId),
      `expected a seeded row for ${reprint.docLibraryId}`,
    );
  }

  // Mutate one row, then re-seed — ensureStateRows must not clobber it.
  state.get(ENCODE_ZONING_REPRINTS[0].docLibraryId)!.status = "complete";
  await ensureStateRows(db);
  assertEquals(
    state.get(ENCODE_ZONING_REPRINTS[0].docLibraryId)!.status,
    "complete",
    "re-seeding must not reset an already-in-progress/complete row",
  );
});

Deno.test("listIncompleteReprints excludes complete rows and orders by last_invoked_at ascending", async () => {
  const { db, state } = createFakeDb();
  state.set(
    "doc-old",
    makeClaimedRow({
      doc_library_id: "doc-old",
      last_invoked_at: "2020-01-01T00:00:00.000Z",
    }),
  );
  state.set(
    "doc-new",
    makeClaimedRow({
      doc_library_id: "doc-new",
      last_invoked_at: "2026-01-01T00:00:00.000Z",
    }),
  );
  state.set(
    "doc-done",
    makeClaimedRow({ doc_library_id: "doc-done", status: "complete" }),
  );

  const incomplete = await listIncompleteReprints(db);
  assertEquals(incomplete.map((r) => r.doc_library_id), ["doc-old", "doc-new"]);
});

// ── processOneReprint: page-chunking + resume-cursor logic ──────────────────

Deno.test("processOneReprint fetches the page count once and caches it on the state row", async () => {
  const { db, state } = createFakeDb();
  const row = makeClaimedRow({ total_pages: null, next_page: 1 });
  state.set(row.doc_library_id, row);

  let pageCountCalls = 0;
  const fetchPageCount: FetchPageCount = () => {
    pageCountCalls++;
    return Promise.resolve(2);
  };
  const deps: EncodeReprintPreingestDeps = {
    db,
    fetchPageCount,
    fetchOcrChunk: makeFetchOcrChunk(),
  };

  const result = await processOneReprint(deps, state.get(row.doc_library_id)!, {
    deadlineMs: Date.now() + 60_000,
    pagesPerChunk: 5,
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  });

  assertEquals(pageCountCalls, 1);
  assertEquals(result.status, "complete");
  assertEquals(result.totalPages, 2);
});

Deno.test("processOneReprint chunks OCR calls by pagesPerChunk and preserves exact page numbers", async () => {
  const { db, state } = createFakeDb();
  const row = makeClaimedRow({ total_pages: 7, next_page: 1 });
  state.set(row.doc_library_id, row);

  const calls: Array<[number, number]> = [];
  const deps: EncodeReprintPreingestDeps = {
    db,
    fetchPageCount: () => Promise.resolve(7),
    fetchOcrChunk: makeFetchOcrChunk({ onCall: (s, e) => calls.push([s, e]) }),
  };

  const result = await processOneReprint(deps, state.get(row.doc_library_id)!, {
    deadlineMs: Date.now() + 60_000,
    pagesPerChunk: 3,
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  });

  assertEquals(calls, [[1, 3], [4, 6], [7, 7]]);
  assertEquals(result.status, "complete");
  assertEquals(result.pagesCompletedThisRun, 7);

  const persisted = state.get(row.doc_library_id)!;
  assertEquals(persisted.status, "complete");
  assertEquals(persisted.next_page, 8);
  assertEquals(persisted.pages_completed, 7);
  assertEquals(persisted.claim_expires_at, null);
});

Deno.test("processOneReprint stores per-page text with the real page numbers, skipping blank pages", async () => {
  const { db, state, pages } = createFakeDb();
  const row = makeClaimedRow({ total_pages: 3, next_page: 1 });
  state.set(row.doc_library_id, row);

  const deps: EncodeReprintPreingestDeps = {
    db,
    fetchPageCount: () => Promise.resolve(3),
    fetchOcrChunk: makeFetchOcrChunk({ blankPages: new Set([2]) }),
  };

  await processOneReprint(deps, state.get(row.doc_library_id)!, {
    deadlineMs: Date.now() + 60_000,
    pagesPerChunk: 10,
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  });

  assertEquals(pages.size, 2, "page 2 was blank and must not get a row");
  assert(
    pages.has(`${row.doc_library_id}:1`),
    "expected a stored row for page 1",
  );
  assertEquals(pages.get(`${row.doc_library_id}:1`)!.text, "Page 1 content.");
  assert(
    !pages.has(`${row.doc_library_id}:2`),
    "blank page 2 must not be stored",
  );
  assert(
    pages.has(`${row.doc_library_id}:3`),
    "expected a stored row for page 3",
  );
});

Deno.test("processOneReprint stops at the deadline mid-document and checkpoints the resume cursor", async () => {
  const { db, state } = createFakeDb();
  const row = makeClaimedRow({ total_pages: 9, next_page: 1 });
  state.set(row.doc_library_id, row);

  let clock = 0;
  const nowMs = () => clock;
  const fetchOcrChunk = makeFetchOcrChunk({
    onCall: () => {
      clock += 10; // simulate real elapsed time per OCR call
    },
  });

  const deps: EncodeReprintPreingestDeps = {
    db,
    fetchPageCount: () => Promise.resolve(9),
    fetchOcrChunk,
  };

  // Deadline trips exactly after the first chunk (pages 1-3) completes.
  const result = await processOneReprint(deps, state.get(row.doc_library_id)!, {
    deadlineMs: 10,
    pagesPerChunk: 3,
    nowMs,
    nowIso: () => "T-mid",
    newId: () => crypto.randomUUID(),
  });

  assertEquals(result.status, "in_progress");
  assertEquals(result.reason, "deadline");
  assertEquals(result.pagesCompletedThisRun, 3);

  const persisted = state.get(row.doc_library_id)!;
  assertEquals(persisted.status, "in_progress");
  assertEquals(
    persisted.next_page,
    4,
    "resume cursor must point at the next unprocessed page",
  );
  assertEquals(persisted.pages_completed, 3);
  assertEquals(
    persisted.claim_expires_at,
    null,
    "the lease must be released immediately on a deadline exit, not held for the full window",
  );
});

Deno.test("processOneReprint resumes from the persisted cursor on a second invocation and finishes the document", async () => {
  const { db, state } = createFakeDb();
  const row = makeClaimedRow({ total_pages: 9, next_page: 1 });
  state.set(row.doc_library_id, row);

  let clock = 0;
  const nowMs = () => clock;
  const calls: Array<[number, number]> = [];
  const fetchOcrChunk = makeFetchOcrChunk({
    onCall: (s, e) => {
      calls.push([s, e]);
      clock += 10;
    },
  });
  const deps: EncodeReprintPreingestDeps = {
    db,
    fetchPageCount: () => Promise.resolve(9),
    fetchOcrChunk,
  };

  // First invocation: only enough budget for one 3-page chunk.
  const first = await processOneReprint(deps, state.get(row.doc_library_id)!, {
    deadlineMs: 10,
    pagesPerChunk: 3,
    nowMs,
    nowIso: () => "T1",
    newId: () => crypto.randomUUID(),
  });
  assertEquals(first.status, "in_progress");
  assertEquals(calls, [[1, 3]]);

  // Second invocation: generous budget, must resume from next_page=4, not
  // restart from page 1, and must not re-fetch the page count.
  let pageCountCalls = 0;
  const second = await processOneReprint(
    {
      db,
      fetchPageCount: () => {
        pageCountCalls++;
        return Promise.resolve(9);
      },
      fetchOcrChunk,
    },
    state.get(row.doc_library_id)!,
    {
      deadlineMs: 100_000,
      pagesPerChunk: 3,
      nowMs,
      nowIso: () => "T2",
      newId: () => crypto.randomUUID(),
    },
  );

  assertEquals(
    pageCountCalls,
    0,
    "total_pages was already cached; must not re-fetch pdfinfo",
  );
  assertEquals(second.status, "complete");
  assertEquals(
    calls,
    [[1, 3], [4, 6], [7, 9]],
    "second invocation must resume at page 4, not restart at page 1",
  );

  const persisted = state.get(row.doc_library_id)!;
  assertEquals(persisted.status, "complete");
  assertEquals(persisted.pages_completed, 9);
});

// ── runEncodeReprintPreingest: compliance gate + rotation ───────────────────

Deno.test("runEncodeReprintPreingest does no DB work at all when the compliance gate is off", async () => {
  const { db, state } = createFakeDb();
  const deps: EncodeReprintPreingestDeps = {
    db,
    fetchPageCount: () => {
      throw new Error("fetchPageCount must not be called when the gate is off");
    },
    fetchOcrChunk: () => {
      throw new Error("fetchOcrChunk must not be called when the gate is off");
    },
  };

  await withEncodeGate(undefined, async () => {
    const result = await runEncodeReprintPreingest(deps, {
      deadlineMs: Date.now() + 60_000,
    });
    assertEquals(result.reason, "compliance_gate_disabled");
    assertEquals(result.processedReprints.length, 0);
  });

  assertEquals(state.size, 0, "no rows should be seeded when the gate is off");
});

Deno.test("runEncodeReprintPreingest seeds all 18 reprints and completes small ones within one invocation", async () => {
  const { db } = createFakeDb();
  // Every real reprint gets a 1-page document here so the whole rotation can
  // complete inside a single generous-deadline invocation.
  const deps: EncodeReprintPreingestDeps = {
    db,
    fetchPageCount: () => Promise.resolve(1),
    fetchOcrChunk: makeFetchOcrChunk(),
  };

  await withEncodeGate("true", async () => {
    const result = await runEncodeReprintPreingest(deps, {
      deadlineMs: Date.now() + 120_000,
      pagesPerChunk: 5,
    });
    assertEquals(result.reason, "all_complete");
    assertEquals(
      result.processedReprints.length,
      ENCODE_ZONING_REPRINTS.length,
    );
    assert(
      result.processedReprints.every((r) => r.status === "complete"),
      "expected every reprint to finish given a 1-page document and a generous deadline",
    );
  });
});

Deno.test("runEncodeReprintPreingest skips a reprint whose lease is already held and tries the next one", async () => {
  const { db, state } = createFakeDb();
  await withEncodeGate("true", async () => {
    await ensureStateRows(db);
  });

  // Simulate a concurrent invocation already holding the lease on the
  // least-recently-invoked (first) reprint.
  const firstId = ENCODE_ZONING_REPRINTS[0].docLibraryId;
  const secondId = ENCODE_ZONING_REPRINTS[1].docLibraryId;
  state.get(firstId)!.claim_expires_at = new Date(Date.now() + 60_000)
    .toISOString();

  const deps: EncodeReprintPreingestDeps = {
    db,
    fetchPageCount: () => Promise.resolve(1),
    fetchOcrChunk: makeFetchOcrChunk(),
  };

  await withEncodeGate("true", async () => {
    // Tight deadline: only enough time to observe the leased row and then
    // claim+finish exactly one more before running out of loop iterations
    // isn't controlled by wall time here, so use a deadline far enough out
    // to let the whole rotation run, and instead assert on the *content*.
    const result = await runEncodeReprintPreingest(deps, {
      deadlineMs: Date.now() + 120_000,
      pagesPerChunk: 5,
    });

    const leasedEntries = result.processedReprints.filter((r) =>
      r.status === "leased"
    );
    assert(
      leasedEntries.some((r) => r.docLibraryId === firstId),
      "expected the already-leased reprint to show up as skipped/leased",
    );
    assertEquals(
      state.get(firstId)!.status,
      "pending",
      "a leased-elsewhere row must be left untouched, not marked in_progress",
    );
    assertEquals(
      state.get(secondId)!.status,
      "complete",
      "the next reprint in rotation must still get processed",
    );
  });
});
