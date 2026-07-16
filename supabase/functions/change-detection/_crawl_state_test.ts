/**
 * Tests for _crawl_state.ts's resumable, checkpointed per-source crawl --
 * the core new behavior this PR adds. The critical case is the one the old
 * crawler had no way to pass: a deadline hit mid-cycle must checkpoint
 * progress (not lose it), release the lease, and let a *later* invocation
 * resume exactly where the last one stopped rather than restarting from
 * scratch. Also covers claimSource()'s lease/overlap protection, since that's
 * what stops two overlapping invocations from resuming (and corrupting) the
 * same checkpoint at once.
 */

import type { DiscoverySource } from "./_discovery.ts";
import {
  claimSource,
  type CrawlStateDb,
  type HeadFetchResult,
  runDiscoverySourceCycle,
} from "./_crawl_state.ts";
import { crawlStateRow, FakeOrchestrateDb } from "./_test_fake_db.ts";

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

function asCrawlStateDb(db: FakeOrchestrateDb): CrawlStateDb {
  return db as unknown as CrawlStateDb;
}

const ROOT = "https://x.example.gov/root";
const DOC1 = "https://x.example.gov/docs/doc1.pdf";
const DOC2 = "https://x.example.gov/docs/doc2.pdf";

const SOURCE: DiscoverySource = {
  id: "bos_summary",
  doc_type: "bos_summary",
  discovery_urls: [ROOT],
  discovery_depth: 1,
  allow_patterns: ["https://x.example.gov/docs/"],
};

function fakeFetchPage(pages: Record<string, string>) {
  return (url: string) => {
    const html = pages[url];
    return Promise.resolve(
      html !== undefined
        ? { ok: true, status: 200, html }
        : { ok: false, status: 404, html: "" },
    );
  };
}

function fakeFetchHead(): Promise<HeadFetchResult> {
  return Promise.resolve({
    ok: true,
    status: 200,
    etag: null,
    lastModified: null,
  });
}

function fakeFetchHash(url: string): Promise<string> {
  return Promise.resolve(`hash:${url}`);
}

const TWO_CANDIDATE_PAGES = {
  [ROOT]: `<a href="${DOC1}">Doc 1</a><a href="${DOC2}">Doc 2</a>`,
};

// ── claimSource: lease / overlap protection ───────────────────────────────────

Deno.test("claimSource refuses to claim a row whose lease has not yet expired", async () => {
  const db = new FakeOrchestrateDb().seedCrawlState([
    crawlStateRow({
      source_id: "bos_summary",
      doc_type: "bos_summary",
      claim_expires_at: "2030-01-01T00:00:00.000Z",
    }),
  ]);

  const claimed = await claimSource(asCrawlStateDb(db), "bos_summary", {
    nowIso: () => "2026-01-01T00:00:00.000Z",
    nowMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
  });

  assertEquals(
    claimed,
    null,
    "a still-leased row must not be claimable by a second invocation",
  );
});

Deno.test("claimSource claims a row whose lease has expired", async () => {
  const db = new FakeOrchestrateDb().seedCrawlState([
    crawlStateRow({
      source_id: "bos_summary",
      doc_type: "bos_summary",
      claim_expires_at: "2020-01-01T00:00:00.000Z",
    }),
  ]);

  const claimed = await claimSource(asCrawlStateDb(db), "bos_summary", {
    nowIso: () => "2026-01-01T00:00:00.000Z",
    nowMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
    leaseMinutes: 5,
  });

  assert(claimed !== null, "an expired lease must be claimable");
  assertEquals(
    db.crawlState.get("bos_summary")?.claim_expires_at,
    "2026-01-01T00:05:00.000Z",
    "claiming must extend the lease by leaseMinutes from nowMs",
  );
});

Deno.test("claimSource claims a row with no prior lease (null claim_expires_at)", async () => {
  const db = new FakeOrchestrateDb().seedCrawlState([
    crawlStateRow({ source_id: "bos_summary", doc_type: "bos_summary" }),
  ]);

  const claimed = await claimSource(asCrawlStateDb(db), "bos_summary", {
    nowIso: () => "2026-01-01T00:00:00.000Z",
    nowMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
  });

  assert(claimed !== null, "a never-leased row must be claimable");
});

// ── runDiscoverySourceCycle: checkpoint + resume (the core new behavior) ─────

Deno.test("runDiscoverySourceCycle checkpoints mid-cycle when the deadline hits, without losing progress", async () => {
  const db = new FakeOrchestrateDb().seedCrawlState([
    crawlStateRow({ source_id: "bos_summary", doc_type: "bos_summary" }),
  ]);
  const claimed = await claimSource(asCrawlStateDb(db), "bos_summary");
  assert(claimed !== null, "setup: claim must succeed");

  // First nowMs() call (before the crawl-phase batch) passes; the second
  // (checked again right after that batch's checkpoint, before scan phase
  // starts) is already past deadlineMs -- forcing exactly a one-batch
  // (crawl-phase-only) partial run, the same shape a real ~150s IDLE_TIMEOUT
  // kill produces mid-crawl.
  let calls = 0;
  const scriptedNowMs = () => {
    calls++;
    return calls === 1 ? 1_000 : 999_999;
  };

  const result = await runDiscoverySourceCycle(
    {
      db: asCrawlStateDb(db),
      source: SOURCE,
      allSources: [SOURCE],
      fetchPage: fakeFetchPage(TWO_CANDIDATE_PAGES),
      fetchHead: fakeFetchHead,
      fetchHash: fakeFetchHash,
    },
    claimed,
    { deadlineMs: 500_000, nowMs: scriptedNowMs },
  );

  assertEquals(result.cycleCompleted, false);
  assertEquals(result.reason, "deadline");
  assertEquals(
    result.pagesFetchedThisRun,
    1,
    "the root page was fetched before the deadline hit",
  );
  assertEquals(
    result.pendingIngestionsCreatedThisRun,
    0,
    "the deadline hit before the scan phase ever ran",
  );

  const row = db.crawlState.get("bos_summary");
  assert(row !== undefined, "row must still exist");
  assertEquals(row.status, "in_progress");
  assertEquals(
    row.claim_expires_at,
    null,
    "the lease must be released so a later invocation can resume",
  );
  const resumeState = row.resume_state as {
    phase: string;
    crawl_queue: unknown[];
    scan_queue: string[];
  };
  // The deadline is checked at the top of every loop iteration, before the
  // crawl_queue-drained -> phase="scan" transition runs -- so the checkpoint
  // lands with phase still "crawl" but an empty crawl_queue and both
  // candidates already moved into scan_queue. The next invocation's first
  // loop iteration makes the phase="scan" transition for free.
  assertEquals(resumeState.phase, "crawl");
  assertEquals(
    resumeState.crawl_queue,
    [],
    "the root page's crawl_queue entry was drained by the one completed batch",
  );
  assertEquals(
    [...resumeState.scan_queue].sort(),
    [DOC1, DOC2],
    "both candidate URLs discovered before the deadline must be preserved in the checkpoint",
  );
});

Deno.test("a later invocation resumes an interrupted cycle from its checkpoint and completes it", async () => {
  const db = new FakeOrchestrateDb().seedCrawlState([
    crawlStateRow({ source_id: "bos_summary", doc_type: "bos_summary" }),
  ]);

  // Run 1: interrupted after the crawl phase (same setup as the test above).
  const firstClaim = await claimSource(asCrawlStateDb(db), "bos_summary");
  assert(firstClaim !== null, "setup: claim must succeed");
  let calls = 0;
  await runDiscoverySourceCycle(
    {
      db: asCrawlStateDb(db),
      source: SOURCE,
      allSources: [SOURCE],
      fetchPage: fakeFetchPage(TWO_CANDIDATE_PAGES),
      fetchHead: fakeFetchHead,
      fetchHash: fakeFetchHash,
    },
    firstClaim,
    { deadlineMs: 500_000, nowMs: () => (++calls === 1 ? 1_000 : 999_999) },
  );

  // Run 2: a fresh invocation (e.g. the next cron tick) claims the same
  // source and must pick up exactly at the scan phase, not restart the crawl.
  const secondClaim = await claimSource(asCrawlStateDb(db), "bos_summary");
  assert(secondClaim !== null, "the released lease must be claimable again");
  assertEquals(
    secondClaim.status,
    "in_progress",
    "resuming an interrupted cycle, not starting a fresh one",
  );

  let pageFetchesInRun2 = 0;
  const countingFetchPage = (url: string) => {
    pageFetchesInRun2++;
    return fakeFetchPage(TWO_CANDIDATE_PAGES)(url);
  };

  const result = await runDiscoverySourceCycle(
    {
      db: asCrawlStateDb(db),
      source: SOURCE,
      allSources: [SOURCE],
      fetchPage: countingFetchPage,
      fetchHead: fakeFetchHead,
      fetchHash: fakeFetchHash,
    },
    secondClaim,
    { deadlineMs: Date.now() + 60_000 },
  );

  assertEquals(
    pageFetchesInRun2,
    0,
    "resuming at the scan phase must not re-crawl the already-visited root page",
  );
  assertEquals(result.cycleCompleted, true);
  assertEquals(result.reason, "queue_drained");
  assertEquals(
    result.pendingIngestionsCreatedThisRun,
    2,
    "both checkpointed candidates must be scanned and ingested",
  );

  const row = db.crawlState.get("bos_summary");
  assertEquals(
    row?.status,
    "idle",
    "a completed cycle returns to idle, ready for the next one -- never a terminal state",
  );
  assertEquals(row?.cycles_completed, 1);
  assertEquals(db.pendingIngestions.size, 2);
});

Deno.test("runDiscoverySourceCycle completes a full cycle in one invocation when the deadline allows", async () => {
  const db = new FakeOrchestrateDb().seedCrawlState([
    crawlStateRow({ source_id: "bos_summary", doc_type: "bos_summary" }),
  ]);
  const claimed = await claimSource(asCrawlStateDb(db), "bos_summary");
  assert(claimed !== null, "setup: claim must succeed");

  const result = await runDiscoverySourceCycle(
    {
      db: asCrawlStateDb(db),
      source: SOURCE,
      allSources: [SOURCE],
      fetchPage: fakeFetchPage(TWO_CANDIDATE_PAGES),
      fetchHead: fakeFetchHead,
      fetchHash: fakeFetchHash,
    },
    claimed,
    { deadlineMs: Date.now() + 60_000 },
  );

  assertEquals(result.cycleCompleted, true);
  assertEquals(result.reason, "queue_drained");
  assertEquals(result.pendingIngestionsCreatedThisRun, 2);
  assertEquals(db.crawlState.get("bos_summary")?.status, "idle");
});

Deno.test("runDiscoverySourceCycle skips creating a pending_ingestion when one is already active for the same URL", async () => {
  const db = new FakeOrchestrateDb().seedCrawlState([
    crawlStateRow({ source_id: "bos_summary", doc_type: "bos_summary" }),
  ]);
  // Simulate an already-active pending_ingestion for DOC1 (e.g. created by a
  // concurrent source or a still-processing prior detection) by going
  // through the same insert path createPendingIngestionIfAbsent uses, so the
  // fake's active-key tracking (which lives inside from("pending_ingestions"))
  // sees it.
  const seeded = await db.from("pending_ingestions").insert({
    id: "existing-1",
    url: DOC1,
    doc_type: "bos_summary",
    status: "pending",
  });
  assertEquals(
    seeded.error,
    null,
    "setup: seeding the active ingestion must not itself collide",
  );

  const claimed = await claimSource(asCrawlStateDb(db), "bos_summary");
  assert(claimed !== null, "setup: claim must succeed");

  const result = await runDiscoverySourceCycle(
    {
      db: asCrawlStateDb(db),
      source: SOURCE,
      allSources: [SOURCE],
      fetchPage: fakeFetchPage(TWO_CANDIDATE_PAGES),
      fetchHead: fakeFetchHead,
      fetchHash: fakeFetchHash,
    },
    claimed,
    { deadlineMs: Date.now() + 60_000 },
  );

  assertEquals(
    result.pendingIngestionsCreatedThisRun,
    1,
    "only DOC2 should create a fresh pending_ingestion",
  );
  assertEquals(
    result.activeIngestionsSkippedThisRun,
    1,
    "DOC1 already has an active pending_ingestion",
  );
});
