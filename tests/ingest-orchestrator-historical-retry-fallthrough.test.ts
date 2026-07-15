/**
 * Tests for the "historical embedding retry starves regular ingestion" fix
 * (PR #93 blocking-audit follow-up on fix/historical-embedding-requeue-2).
 *
 * Bug: the normal cron-poll path in index.ts returned early after
 * handleMunicodeHistoricalEmbeddingRetry() whenever it did ANY work
 * (processed > 0 || scheduled > 0), even when the retry batch fully drained
 * within its deadline budget (complete: true). Since the retry queue only
 * needs one due row to trigger this, a single due historical-embedding-retry
 * row starved the regular pending_ingestions loop for the entire ~3-minute
 * cron tick -- the exact throughput problem already fixed once this week for
 * regular ingestion.
 *
 * Fix: only skip the regular pending_ingestions loop when the retry
 * genuinely ran out of deadline budget (`!complete`), not merely because it
 * did some work. index.ts's SOFT_DEADLINE_MS/CLAIM_DEADLINE_MS are absolute
 * timestamps anchored to FUNCTION_START_MS (not relative windows), so
 * falling through automatically hands the regular loop whatever budget is
 * left -- no new deadline-handoff plumbing needed; this mirrors the existing
 * pattern already used for ordinance-provisions embedding (see the
 * `softDeadlineMs - Date.now()` handoff a few hundred lines earlier in the
 * same file).
 *
 * These tests avoid a live Supabase instance (unavailable in CI, matching
 * the convention already established across this test suite) by:
 *   1. reading the fixed guard condition directly out of the live
 *      orchestrator source (not a hand-copied reimplementation that could
 *      silently drift from the real fix) and evaluating it against
 *      realistic MunicodeHistoricalEmbeddingRetryResult values -- including
 *      the exact bug scenario (processed > 0, complete: true).
 *   2. behaviorally proving the "falls through" half of that guard actually
 *      matters: using the REAL, unmodified runPendingIngestionLoop from
 *      _multi-row-loop.ts (the function index.ts hands off to immediately
 *      after this guard), confirming that when the guard says "fall
 *      through", regular pending_ingestions rows really do get claimed and
 *      processed in the same invocation -- not just that a boolean flips.
 */

import type { MunicodeHistoricalEmbeddingRetryResult } from "../supabase/functions/ingest-orchestrator/municode.ts";
import {
  type ClaimNextResult,
  type PendingIngestionClaim,
  runPendingIngestionLoop,
} from "../supabase/functions/ingest-orchestrator/_multi-row-loop.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const INDEX_SRC_PATH = new URL(
  "../supabase/functions/ingest-orchestrator/index.ts",
  import.meta.url,
).pathname;

// Extracts the live guard condition (the boolean expression in the
// `if (...)` right after handleMunicodeHistoricalEmbeddingRetry) out of the
// actual orchestrator source, so these tests exercise the real fix text
// rather than a hand-typed copy of it that could pass even if the source
// regressed.
async function loadShouldReturnEarly(): Promise<
  (result: MunicodeHistoricalEmbeddingRetryResult) => boolean
> {
  const src = await Deno.readTextFile(INDEX_SRC_PATH);
  const anchor =
    "await handleMunicodeHistoricalEmbeddingRetry(SOFT_DEADLINE_MS);";
  const anchorIdx = src.indexOf(anchor);
  assert(
    anchorIdx !== -1,
    "handleMunicodeHistoricalEmbeddingRetry call site not found",
  );
  const ifStart = src.indexOf("if (", anchorIdx);
  const ifOpenBrace = src.indexOf("{", ifStart);
  assert(
    ifStart !== -1 && ifOpenBrace !== -1,
    "guard `if` not found after the historical embedding retry call",
  );
  const raw = src.slice(ifStart + "if (".length, ifOpenBrace).trim();
  const expr = raw.endsWith(")") ? raw.slice(0, -1) : raw;
  const fn = new Function(
    "historicalEmbeddingRetry",
    `"use strict"; return (${expr});`,
  ) as (r: MunicodeHistoricalEmbeddingRetryResult) => boolean;
  return fn;
}

Deno.test(
  "guard: retry that completes within budget after doing work does NOT return early -- the exact bug scenario",
  async () => {
    const shouldReturnEarly = await loadShouldReturnEarly();
    const result: MunicodeHistoricalEmbeddingRetryResult = {
      processed: 3,
      scheduled: 0,
      complete: true,
    };
    assertEquals(
      shouldReturnEarly(result),
      false,
      "a retry batch that finished within its deadline must fall through to regular ingestion, even though it processed rows",
    );
  },
);

Deno.test(
  "guard: retry that scheduled rows (embed URL unavailable) but still completed does NOT return early",
  async () => {
    const shouldReturnEarly = await loadShouldReturnEarly();
    const result: MunicodeHistoricalEmbeddingRetryResult = {
      processed: 0,
      scheduled: 4,
      complete: true,
      reason: "embed_url_unavailable",
    };
    assertEquals(shouldReturnEarly(result), false);
  },
);

Deno.test(
  "guard: retry that genuinely ran out of deadline budget still returns early",
  async () => {
    const shouldReturnEarly = await loadShouldReturnEarly();
    const result: MunicodeHistoricalEmbeddingRetryResult = {
      processed: 1,
      scheduled: 0,
      complete: false,
      reason: "soft_deadline",
    };
    assertEquals(shouldReturnEarly(result), true);
  },
);

Deno.test(
  "guard: idle retry (nothing due) does not return early",
  async () => {
    const shouldReturnEarly = await loadShouldReturnEarly();
    const result: MunicodeHistoricalEmbeddingRetryResult = {
      processed: 0,
      scheduled: 0,
      complete: true,
    };
    assertEquals(shouldReturnEarly(result), false);
  },
);

// ---------------------------------------------------------------------------
// Behavioral: prove the fallthrough actually reaches regular ingestion, using
// the real (unmodified) runPendingIngestionLoop -- the exact function
// index.ts hands off to immediately after this guard.
// ---------------------------------------------------------------------------

Deno.test(
  "behavioral: after a completed-with-work historical retry, the real pending_ingestions loop claims and processes rows in the same invocation",
  async () => {
    const shouldReturnEarly = await loadShouldReturnEarly();
    const historicalEmbeddingRetry: MunicodeHistoricalEmbeddingRetryResult = {
      processed: 3,
      scheduled: 0,
      complete: true,
    };

    // Mirrors index.ts's own control flow: only proceed to the regular loop
    // when the (real, source-derived) guard says to.
    assert(
      !shouldReturnEarly(historicalEmbeddingRetry),
      "test setup invalid: guard unexpectedly returned early for a completed retry",
    );

    const fakeQueue: PendingIngestionClaim[] = [
      {
        row: {
          id: "row-1",
          url: "https://example.com/1",
          doc_type: "budget_pdf",
          attempts: 0,
          status: "pending",
        },
        newAttempts: 1,
      },
      {
        row: {
          id: "row-2",
          url: "https://example.com/2",
          doc_type: "budget_pdf",
          attempts: 0,
          status: "pending",
        },
        newAttempts: 1,
      },
    ];
    let claimCalls = 0;
    const processedIds: string[] = [];

    const loop = await runPendingIngestionLoop({
      deadlineMs: Date.now() + 60_000,
      claimNext: (): Promise<ClaimNextResult> => {
        claimCalls += 1;
        const next = fakeQueue.shift();
        if (!next) return Promise.resolve({ kind: "idle" });
        return Promise.resolve({ kind: "claimed", claim: next });
      },
      processClaim: (claim) => {
        processedIds.push(claim.row.id);
        return Promise.resolve({ id: claim.row.id, ok: true, status: 200 });
      },
    });

    assertEquals(
      claimCalls,
      3,
      "loop must keep claiming until idle (2 real rows + 1 idle check)",
    );
    assertEquals(
      processedIds,
      ["row-1", "row-2"],
      "regular ingestion must actually claim and process the rows queued after the historical retry fell through",
    );
    assertEquals(loop.processed, 2);
    assertEquals(loop.status, "processed");
  },
);
