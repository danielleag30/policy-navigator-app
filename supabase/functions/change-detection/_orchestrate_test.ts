/**
 * Tests for _orchestrate.ts's per-invocation shape, centered on the
 * starvation-regression guarantee described in its file header: Municode,
 * EnCode zoning, and the staleness sweep (Phase 2) must run every invocation
 * regardless of how the discovery-source loop (Phase 1) exits -- deadline
 * reached, a source leased by a concurrent invocation, or an unexpected
 * throw. PR #93/#94 (see git history) shipped a real production incident
 * where an ancillary step throwing before the main loop skipped regular work
 * for the whole cron tick; the first test below reproduces that exact shape
 * against claimSource() and would have caught the gap fixed alongside these
 * tests (claimSource() was outside the discovery loop's try/catch).
 *
 * Also covers the PR-specific guardrails: EnCode's independent min-interval
 * cadence and compliance gate, and alert dedupe across invocations.
 */

import type { ApiSource, DiscoverySource, SeedConfig } from "./_discovery.ts";
import {
  type OrchestrateDb,
  type OrchestrateDeps,
  runChangeDetectionCycle,
  UnknownSourceError,
} from "./_orchestrate.ts";
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

function asOrchestrateDb(db: FakeOrchestrateDb): OrchestrateDb {
  return db as unknown as OrchestrateDb;
}

const DISCOVERY_SOURCE: DiscoverySource = {
  id: "bos_summary",
  doc_type: "bos_summary",
  discovery_urls: ["https://x.example.gov/root"],
  discovery_depth: 1,
  allow_patterns: ["https://x.example.gov/docs/"],
};

const MUNICODE_SOURCE: ApiSource = {
  doc_type: "municode_api",
  base_url: "https://api.municode.com",
  url_patterns: ["https://api.municode.com/Jobs/latest/12345"],
};

const ENCODE_SOURCE: ApiSource = {
  doc_type: "encode_zoning",
  base_url: "https://library.municode.com/va/fairfax_county",
  url_patterns: ["https://library.municode.com/va/fairfax_county/regs"],
};

const CONFIG: SeedConfig = {
  version: "1",
  sources: [DISCOVERY_SOURCE, MUNICODE_SOURCE, ENCODE_SOURCE],
};

function seedAllCrawlState(db: FakeOrchestrateDb): FakeOrchestrateDb {
  return db.seedCrawlState([
    crawlStateRow({ source_id: "bos_summary", doc_type: "bos_summary" }),
    crawlStateRow({ source_id: "municode_api", doc_type: "municode_api" }),
    crawlStateRow({ source_id: "encode_zoning", doc_type: "encode_zoning" }),
  ]);
}

function baseDeps(
  db: FakeOrchestrateDb,
  overrides: Partial<OrchestrateDeps> = {},
): OrchestrateDeps {
  return {
    db: asOrchestrateDb(db),
    config: CONFIG,
    fetchPage: () => Promise.resolve({ ok: true, status: 200, html: "" }),
    fetchHead: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        etag: null,
        lastModified: null,
      }),
    fetchHash: (url: string) => Promise.resolve(`hash:${url}`),
    fetchJson: () => Promise.resolve({ jobId: "job-1" }),
    triggerReconciliation: () => Promise.resolve(true),
    isEncodeZoningEnabled: () => true,
    ...overrides,
  };
}

// ── Starvation regression (PR #93/#94 pattern) ────────────────────────────────

Deno.test("claimSource() throwing for a discovery source does not skip Municode/EnCode/staleness this invocation", async () => {
  const db = seedAllCrawlState(new FakeOrchestrateDb());
  // Forces the very first discovery_crawl_state update call for bos_summary
  // -- claimSource()'s own claim UPDATE, not runDiscoverySourceCycle's
  // checkpoint -- to fail, the same shape a transient DB error would produce.
  db.failNextUpdateFor.set("bos_summary", "simulated transient DB error");

  const result = await runChangeDetectionCycle(baseDeps(db));

  assertEquals(result.errors.length, 1);
  assert(
    result.errors[0].includes("bos_summary") &&
      result.errors[0].includes("simulated transient DB error"),
    `expected the claim failure to be recorded, got: ${result.errors[0]}`,
  );
  assert(
    result.municode.checked,
    "Municode must still be checked despite the discovery claim failure",
  );
  assert(
    result.encode_zoning.checked,
    "EnCode zoning must still be checked despite the discovery claim failure",
  );
});

Deno.test("the discovery deadline already having passed does not skip Municode/EnCode/staleness this invocation", async () => {
  const db = seedAllCrawlState(new FakeOrchestrateDb());
  db.seedDocuments([
    {
      id: "doc-1",
      url: "https://x.example.gov/stale.pdf",
      doc_type: "bos_summary",
      status: "current",
      content_hash: "h1",
      last_checked_at: "2020-01-01T00:00:00.000Z",
    },
  ]);

  let discoveryFetchCalled = false;
  const result = await runChangeDetectionCycle(
    baseDeps(db, {
      fetchPage: () => {
        discoveryFetchCalled = true;
        return Promise.resolve({ ok: true, status: 200, html: "" });
      },
    }),
    // totalDeadlineMs - reservedTailMs = 0 -> discoveryDeadline === runStart,
    // so the loop's very first deadline check breaks before claiming anything.
    {
      totalDeadlineMs: 0,
      reservedTailMs: 0,
      nowMs: () => Date.parse("2026-07-15T00:00:00.000Z"),
      nowIso: () => "2026-07-15T00:00:00.000Z",
    },
  );

  assertEquals(result.discovery.sources_attempted, 0);
  assert(
    !discoveryFetchCalled,
    "no discovery page fetch should happen once the deadline has already passed",
  );
  assert(
    result.municode.checked,
    "Municode must still run when the discovery phase gets zero time",
  );
  assert(
    result.encode_zoning.checked,
    "EnCode zoning must still run when the discovery phase gets zero time",
  );
  assertEquals(result.stale_documents_found, 1);
  assertEquals(result.stale_alerts_created, 1);
});

Deno.test("Municode check throwing does not skip EnCode zoning or the staleness sweep", async () => {
  const db = seedAllCrawlState(new FakeOrchestrateDb());

  const result = await runChangeDetectionCycle(
    baseDeps(db, {
      fetchJson: () => Promise.reject(new Error("municode API unreachable")),
    }),
  );

  assert(!result.municode.checked, "Municode itself failed");
  assert(
    result.errors.some((e) => e.includes("municode API unreachable")),
    "expected the Municode failure to be recorded in errors",
  );
  assert(
    result.encode_zoning.checked,
    "EnCode zoning must still run after Municode throws",
  );
});

// ── EnCode zoning's independent cadence guardrail ─────────────────────────────

Deno.test("EnCode zoning is skipped (not double-checked) inside its own minimum interval", async () => {
  const db = new FakeOrchestrateDb().seedCrawlState([
    crawlStateRow({ source_id: "bos_summary", doc_type: "bos_summary" }),
    crawlStateRow({ source_id: "municode_api", doc_type: "municode_api" }),
    crawlStateRow({
      source_id: "encode_zoning",
      doc_type: "encode_zoning",
      last_checked_at: "2026-07-14T20:00:00.000Z",
    }),
  ]);

  const result = await runChangeDetectionCycle(
    baseDeps(db),
    {
      // 1h after last_checked_at, well inside the 6h default min interval.
      nowMs: () => Date.parse("2026-07-14T21:00:00.000Z"),
      nowIso: () => "2026-07-14T21:00:00.000Z",
    },
  );

  assertEquals(result.encode_zoning.checked, false);
  assertEquals(result.encode_zoning.skipped_reason, "min_interval");
  assertEquals(result.encode_zoning.pending_ingestion_id, null);
});

Deno.test("EnCode zoning runs again once its minimum interval has elapsed", async () => {
  const db = new FakeOrchestrateDb().seedCrawlState([
    crawlStateRow({ source_id: "bos_summary", doc_type: "bos_summary" }),
    crawlStateRow({ source_id: "municode_api", doc_type: "municode_api" }),
    crawlStateRow({
      source_id: "encode_zoning",
      doc_type: "encode_zoning",
      last_checked_at: "2026-07-14T00:00:00.000Z",
    }),
  ]);

  const result = await runChangeDetectionCycle(
    baseDeps(db),
    {
      // 7h later, past the 6h default min interval.
      nowMs: () => Date.parse("2026-07-14T07:00:00.000Z"),
      nowIso: () => "2026-07-14T07:00:00.000Z",
    },
  );

  assertEquals(result.encode_zoning.checked, true);
  assertEquals(result.encode_zoning.skipped_reason, null);
});

Deno.test("EnCode zoning's compliance gate skips the check without ever claiming its lease", async () => {
  const db = seedAllCrawlState(new FakeOrchestrateDb());

  const result = await runChangeDetectionCycle(
    baseDeps(db, { isEncodeZoningEnabled: () => false }),
  );

  assertEquals(result.encode_zoning.checked, false);
  assertEquals(result.encode_zoning.skipped_reason, "disabled");
  assertEquals(
    db.crawlState.get("encode_zoning")?.claim_expires_at,
    null,
    "the disabled gate must short-circuit before ever claiming the lease",
  );
});

// ── Lease/overlap protection at the orchestration level ───────────────────────

Deno.test("a discovery source already leased by a concurrent invocation is skipped, not retried, and Phase 2 still runs", async () => {
  const db = new FakeOrchestrateDb().seedCrawlState([
    crawlStateRow({
      source_id: "bos_summary",
      doc_type: "bos_summary",
      claim_expires_at: "2030-01-01T00:00:00.000Z",
    }),
    crawlStateRow({ source_id: "municode_api", doc_type: "municode_api" }),
    crawlStateRow({ source_id: "encode_zoning", doc_type: "encode_zoning" }),
  ]);

  const result = await runChangeDetectionCycle(
    baseDeps(db),
    {
      nowMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
      nowIso: () => "2026-01-01T00:00:00.000Z",
    },
  );

  assertEquals(result.discovery.sources_leased, 1);
  assertEquals(result.discovery.sources[0].outcome, "leased");
  assert(
    result.municode.checked,
    "Municode must still run even though the only discovery source was leased",
  );
});

// ── Alert dedupe across invocations ────────────────────────────────────────────

Deno.test("a repeated staleness condition within the cooldown window does not write a duplicate alert", async () => {
  const db = seedAllCrawlState(new FakeOrchestrateDb());
  db.seedDocuments([
    {
      id: "doc-1",
      url: "https://x.example.gov/stale.pdf",
      doc_type: "bos_summary",
      status: "current",
      content_hash: "h1",
      last_checked_at: "2020-01-01T00:00:00.000Z",
    },
  ]);

  const options = {
    nowMs: () => Date.parse("2026-07-15T00:00:00.000Z"),
    nowIso: () => "2026-07-15T00:00:00.000Z",
    alertCooldownMs: 60 * 60 * 1000,
  };

  const first = await runChangeDetectionCycle(baseDeps(db), options);
  assertEquals(first.stale_alerts_created, 1);

  // A second invocation 10 minutes later, still observing the same stale
  // document, must not write a second alert -- the same condition recurring
  // minutes apart under a tightened cadence is exactly the noise dedupe
  // exists to suppress.
  const second = await runChangeDetectionCycle(baseDeps(db), {
    ...options,
    nowMs: () => Date.parse("2026-07-15T00:10:00.000Z"),
    nowIso: () => "2026-07-15T00:10:00.000Z",
  });
  assertEquals(second.stale_documents_found, 1, "the document is still stale");
  assertEquals(
    second.stale_alerts_created,
    0,
    "but no new alert should be written inside the cooldown",
  );
  assertEquals(db.alerts.length, 1);
});

// ── requestedSourceId scoping ──────────────────────────────────────────────────

Deno.test("an unknown requestedSourceId throws UnknownSourceError before touching the database", async () => {
  const db = seedAllCrawlState(new FakeOrchestrateDb());

  let threw: unknown;
  try {
    await runChangeDetectionCycle(baseDeps(db), {
      requestedSourceId: "not_a_real_source",
    });
  } catch (e) {
    threw = e;
  }

  assert(threw instanceof UnknownSourceError, "expected UnknownSourceError");
});
