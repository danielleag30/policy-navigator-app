/**
 * Resumable, checkpointed per-source discovery crawl for change-detection.
 *
 * WHY THIS EXISTS: the previous change-detection crawled all 5 discovery
 * sources in one unscoped pass with zero deadline/checkpoint logic, and
 * confirmed live to die at the platform's ~150s IDLE_TIMEOUT after only ~2
 * candidate scans -- losing all progress, every single 6-hour tick, so real
 * new content was never discovered. This module makes each discovery
 * source's crawl a resumable state machine: a bounded batch of work is done,
 * the result is checkpointed to discovery_crawl_state, and the next
 * invocation (this one if there's time left, or the next cron tick)
 * continues exactly where the last checkpoint left off.
 *
 * Two phases per cycle:
 *   'crawl' -- BFS the discovery_urls tree (mirrors the old
 *              crawlDiscoverySource, but processes crawl_queue in
 *              checkpointed batches instead of draining it in one pass).
 *              A link is either recursed into (queued for the next depth)
 *              or, if terminal (matches this seed config's allow_patterns
 *              or looks like a document), resolved to its owning source via
 *              resolveOwnerSourceId() -- the same match_priority
 *              cross-source resolution the old resolveCandidates() did, but
 *              evaluable per-URL the moment it's discovered. Owned URLs are
 *              queued into scan_queue; URLs owned by a different source are
 *              left for that source's own crawl to find independently.
 *   'scan'  -- HEAD/hash-compare each queued candidate URL against any
 *              existing current document (mirrors the old scanSeedUrl),
 *              creating a pending_ingestion for anything new or changed.
 *
 * When scan_queue drains, the cycle is complete: the row goes back to
 * 'idle' ("ready to start a new cycle"), never a terminal "done forever"
 * state -- the whole point of this being a *recurring* crawl.
 *
 * Concurrency within a batch (mapWithConcurrency, same shape the old
 * crawler used) overlaps network round-trips; the checkpoint boundary is
 * per-batch rather than per-item, trading a small amount of possible
 * re-work (at most one batch, bounded by crawlBatchSize/scanBatchSize) for
 * meaningfully higher throughput per invocation than a fully sequential
 * one-item-at-a-time loop.
 *
 * Overlap protection: claimSource()/persistCrawlState() use the same
 * atomic-claim lease shape as documents.resume_claim_expires_at
 * (findResumableDocument() in municode.ts) so two invocations can never
 * work the same source's checkpoint at once -- see the migration's header
 * comment for why this is needed even with cron_invoke_edge_function's
 * advisory lock in place.
 */

import { generate as uuidv7 } from "@std/uuid/v7";
import {
  createPendingIngestionIfAbsent,
  type PendingIngestionDb,
} from "../_shared/pending-ingestion.ts";
import {
  type DiscoverySource,
  type DocType,
  extractLinks,
  looksLikeDocumentUrl,
  mapWithConcurrency,
  matchesAllowPattern,
  type PageFetcher,
  resolveOwnerSourceId,
  shouldFollowLink,
} from "./_discovery.ts";

export interface CrawlQueueItem {
  url: string;
  depth: number;
}

export interface DiscoveryResumeState {
  version: 1;
  phase: "crawl" | "scan";
  crawl_queue: CrawlQueueItem[];
  visited_urls: string[];
  seen_candidate_urls: string[];
  scan_queue: string[];
}

export interface CrawlErrorEntry {
  url: string;
  message: string;
}

export interface CrawlStateRow {
  source_id: string;
  doc_type: DocType;
  budget_stage?: "advertised" | "adopted" | null;
  status: "idle" | "in_progress";
  resume_state: DiscoveryResumeState | Record<string, never>;
  claim_expires_at: string | null;
  cycle_started_at: string | null;
  last_cycle_completed_at: string | null;
  last_checked_at: string | null;
  cycles_completed: number;
  pages_fetched: number;
  candidate_urls_seen: number;
  pending_ingestions_created: number;
  active_ingestions_skipped: number;
  last_checked_updates: number;
  errors: CrawlErrorEntry[];
  last_invoked_at: string;
  last_error: string | null;
}

export interface DbError {
  code?: string;
  message: string;
}

interface MaybeSingleResult<T> {
  data: T | null;
  error: DbError | null;
}

interface CrawlStateUpdateChain {
  eq(column: "source_id", value: string): CrawlStateUpdateChain;
  or(condition: string): CrawlStateUpdateChain;
  select(columns: string): {
    maybeSingle(): PromiseLike<MaybeSingleResult<CrawlStateRow>>;
  };
}

interface CrawlStateListChain {
  order(column: string, opts: { ascending: boolean }): PromiseLike<{
    data: CrawlStateRow[] | null;
    error: DbError | null;
  }>;
}

interface CrawlStateTable {
  update(payload: Record<string, unknown>): CrawlStateUpdateChain;
  select(columns: string): CrawlStateListChain;
}

export interface CurrentDocument {
  id: string;
  url: string;
  doc_type: DocType;
  content_hash: string;
  last_checked_at: string;
}

export interface DocumentsSelectChain {
  eq(column: string, value: string): DocumentsSelectChain;
  /** Used by change-detection's staleness sweep (_orchestrate.ts). */
  lt(column: string, value: string): PromiseLike<{
    data: CurrentDocument[] | null;
    error: DbError | null;
  }>;
  maybeSingle(): PromiseLike<MaybeSingleResult<CurrentDocument>>;
}

interface DocumentsUpdateChain {
  eq(column: string, value: string): PromiseLike<{ error: DbError | null }>;
}

export interface DocumentsTable {
  select(columns: string): DocumentsSelectChain;
  update(payload: Record<string, unknown>): DocumentsUpdateChain;
}

export type CrawlStateDb = PendingIngestionDb & {
  from(table: "discovery_crawl_state"): CrawlStateTable;
  from(table: "documents"): DocumentsTable;
};

export interface HeadFetchResult {
  ok: boolean;
  status: number;
  etag: string | null;
  lastModified: string | null;
}

export type HeadFetcher = (url: string) => Promise<HeadFetchResult>;
export type HashFetcher = (url: string) => Promise<string>;

const DEFAULT_MAX_PAGES = 500;
const DEFAULT_CRAWL_BATCH_SIZE = 8;
const DEFAULT_SCAN_BATCH_SIZE = 8;
export const DEFAULT_LEASE_MINUTES = 5;

export function initialDiscoveryResumeState(
  source: DiscoverySource,
): DiscoveryResumeState {
  return {
    version: 1,
    phase: "crawl",
    crawl_queue: source.discovery_urls.map((url) => ({ url, depth: 1 })),
    visited_urls: [...source.discovery_urls],
    seen_candidate_urls: [],
    scan_queue: [],
  };
}

/**
 * Atomically claims a discovery_crawl_state row for the duration of this
 * invocation's work on it: a conditional UPDATE ... WHERE claim_expires_at
 * IS NULL OR claim_expires_at < now() ... RETURNING, the same shape as
 * documents.resume_claim_expires_at. Returns null if another invocation
 * already holds an unexpired lease on this source — the caller must skip
 * that source this tick rather than risk double-processing its checkpoint.
 */
export async function claimSource(
  db: CrawlStateDb,
  sourceId: string,
  options: {
    leaseMinutes?: number;
    nowMs?: () => number;
    nowIso?: () => string;
  } = {},
): Promise<CrawlStateRow | null> {
  const leaseMinutes = options.leaseMinutes ?? DEFAULT_LEASE_MINUTES;
  const nowMs = options.nowMs ?? (() => Date.now());
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const nowIsoStr = nowIso();
  const leaseExpiresAt = new Date(nowMs() + leaseMinutes * 60 * 1000)
    .toISOString();

  const { data, error: claimErr } = await db
    .from("discovery_crawl_state")
    .update({ claim_expires_at: leaseExpiresAt, last_invoked_at: nowIsoStr })
    .eq("source_id", sourceId)
    .or(`claim_expires_at.is.null,claim_expires_at.lt.${nowIsoStr}`)
    .select("*")
    .maybeSingle();

  if (claimErr) {
    throw new Error(
      `discovery_crawl_state claim failed for ${sourceId}: ${claimErr.message}`,
    );
  }
  return data;
}

/**
 * Lists every discovery_crawl_state row ordered by last_invoked_at ascending
 * (least-recently-attempted first). Used to pick the order sources are
 * worked in each invocation so that when an invocation's deadline only
 * allows time for a subset of sources, later ticks naturally rotate to the
 * sources that got skipped rather than always starting from the same
 * config-order source and starving the rest.
 */
export async function listCrawlStates(
  db: CrawlStateDb,
): Promise<CrawlStateRow[]> {
  const { data, error: listErr } = await db
    .from("discovery_crawl_state")
    .select("*")
    .order("last_invoked_at", { ascending: true });

  if (listErr) {
    throw new Error(`discovery_crawl_state list failed: ${listErr.message}`);
  }
  return data ?? [];
}

export async function persistCrawlState(
  db: CrawlStateDb,
  sourceId: string,
  patch: Record<string, unknown>,
): Promise<CrawlStateRow> {
  const { data, error: persistErr } = await db
    .from("discovery_crawl_state")
    .update(patch)
    .eq("source_id", sourceId)
    .select("*")
    .maybeSingle();

  if (persistErr) {
    throw new Error(
      `discovery_crawl_state persist failed for ${sourceId}: ${persistErr.message}`,
    );
  }
  if (!data) {
    throw new Error(`discovery_crawl_state row missing for ${sourceId}`);
  }
  return data;
}

async function getCurrentDocument(
  db: CrawlStateDb,
  url: string,
): Promise<CurrentDocument | null> {
  const { data, error: lookupErr } = await db
    .from("documents")
    .select("id, url, doc_type, content_hash, last_checked_at")
    .eq("url", url)
    .eq("status", "current")
    .maybeSingle();

  if (lookupErr) {
    throw new Error(`Document lookup failed for ${url}: ${lookupErr.message}`);
  }
  return data;
}

async function updateLastChecked(
  db: CrawlStateDb,
  documentId: string,
  nowIso: string,
): Promise<void> {
  const { error: updateErr } = await db
    .from("documents")
    .update({ last_checked_at: nowIso })
    .eq("id", documentId);

  if (updateErr) {
    throw new Error(
      `Document last_checked_at update failed for ${documentId}: ${updateErr.message}`,
    );
  }
}

function normalizedValidator(value: string): string {
  return value.trim().replace(/^W\//i, "").replace(/^"|"$/g, "").toLowerCase();
}

function headMatchesStoredHash(
  head: HeadFetchResult,
  storedHash: string,
): boolean {
  if (!head.etag) return false;
  const stored = normalizedValidator(storedHash);
  return [head.etag, head.lastModified]
    .filter((v): v is string => Boolean(v))
    .some((v) => normalizedValidator(v) === stored);
}

export type ScanAction =
  | "pending_ingestion_created"
  | "active_ingestion_exists"
  | "last_checked_updated"
  | "error";

export interface ScanResult {
  url: string;
  action: ScanAction;
  message?: string;
  pendingIngestionId?: string | null;
}

async function scanCandidateUrl(
  db: CrawlStateDb,
  url: string,
  docType: DocType,
  budgetStage: "advertised" | "adopted" | null,
  deps: {
    fetchHead: HeadFetcher;
    fetchHash: HashFetcher;
    newId: () => string;
    nowIso: () => string;
  },
): Promise<ScanResult> {
  const current = await getCurrentDocument(db, url);
  const head = await deps.fetchHead(url);

  if (!head.ok && head.status !== 405) {
    throw new Error(`HEAD ${url} returned HTTP ${head.status}`);
  }

  if (current && head.ok && headMatchesStoredHash(head, current.content_hash)) {
    await updateLastChecked(db, current.id, deps.nowIso());
    return { url, action: "last_checked_updated" };
  }

  const hash = await deps.fetchHash(url);
  if (current && hash === current.content_hash) {
    await updateLastChecked(db, current.id, deps.nowIso());
    return { url, action: "last_checked_updated" };
  }

  const pendingId = await createPendingIngestionIfAbsent(db, {
    id: deps.newId(),
    url,
    docType,
    budgetStage,
    nowIso: deps.nowIso(),
  });
  if (!pendingId) return { url, action: "active_ingestion_exists" };
  return {
    url,
    action: "pending_ingestion_created",
    pendingIngestionId: pendingId,
  };
}

export interface CrawlStateDeps {
  db: CrawlStateDb;
  source: DiscoverySource;
  /** All discovery sources in the config, for cross-source match_priority resolution. */
  allSources: readonly DiscoverySource[];
  fetchPage: PageFetcher;
  fetchHead: HeadFetcher;
  fetchHash: HashFetcher;
}

export interface CrawlCycleOptions {
  /** Absolute epoch-ms deadline for this source's work slice this invocation. */
  deadlineMs: number;
  maxPages?: number;
  crawlBatchSize?: number;
  scanBatchSize?: number;
  nowMs?: () => number;
  nowIso?: () => string;
  newId?: () => string;
}

export interface CrawlCycleResult {
  sourceId: string;
  cycleCompleted: boolean;
  reason: "deadline" | "queue_drained";
  pagesFetchedThisRun: number;
  candidateUrlsSeenThisRun: number;
  pendingIngestionsCreatedThisRun: number;
  activeIngestionsSkippedThisRun: number;
  lastCheckedUpdatesThisRun: number;
  errorsThisRun: CrawlErrorEntry[];
}

/**
 * Runs one source's crawl+scan cycle for as long as this invocation's
 * deadline allows, checkpointing after every batch. `claimedRow` must come
 * from a successful claimSource() call — this function does not itself
 * claim or release beyond the checkpoint writes it makes (the deadline-exit
 * checkpoint releases the lease so another invocation can resume
 * immediately rather than waiting out the full lease window; the
 * cycle-complete checkpoint also releases it and flips status back to
 * 'idle').
 */
export async function runDiscoverySourceCycle(
  deps: CrawlStateDeps,
  claimedRow: CrawlStateRow,
  options: CrawlCycleOptions,
): Promise<CrawlCycleResult> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => uuidv7());
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const crawlBatchSize = options.crawlBatchSize ?? DEFAULT_CRAWL_BATCH_SIZE;
  const scanBatchSize = options.scanBatchSize ?? DEFAULT_SCAN_BATCH_SIZE;

  const startingFreshCycle = claimedRow.status === "idle";
  const state: DiscoveryResumeState = startingFreshCycle
    ? initialDiscoveryResumeState(deps.source)
    : (claimedRow.resume_state as DiscoveryResumeState);
  const base = startingFreshCycle
    ? {
      pages: 0,
      candidates: 0,
      created: 0,
      activeSkipped: 0,
      lastCheckedUpdates: 0,
    }
    : {
      pages: claimedRow.pages_fetched,
      candidates: claimedRow.candidate_urls_seen,
      created: claimedRow.pending_ingestions_created,
      activeSkipped: claimedRow.active_ingestions_skipped,
      lastCheckedUpdates: claimedRow.last_checked_updates,
    };

  const visited = new Set(state.visited_urls);
  const seenCandidates = new Set(state.seen_candidate_urls);
  const perRun = {
    pages: 0,
    candidates: 0,
    created: 0,
    activeSkipped: 0,
    lastCheckedUpdates: 0,
  };
  const errorsThisRun: CrawlErrorEntry[] = [];

  function buildResult(
    cycleCompleted: boolean,
    reason: CrawlCycleResult["reason"],
  ): CrawlCycleResult {
    return {
      sourceId: deps.source.id,
      cycleCompleted,
      reason,
      pagesFetchedThisRun: perRun.pages,
      candidateUrlsSeenThisRun: perRun.candidates,
      pendingIngestionsCreatedThisRun: perRun.created,
      activeIngestionsSkippedThisRun: perRun.activeSkipped,
      lastCheckedUpdatesThisRun: perRun.lastCheckedUpdates,
      errorsThisRun,
    };
  }

  async function checkpoint(release: boolean): Promise<void> {
    const payload: Record<string, unknown> = {
      status: "in_progress",
      resume_state: state,
      pages_fetched: base.pages + perRun.pages,
      candidate_urls_seen: base.candidates + perRun.candidates,
      pending_ingestions_created: base.created + perRun.created,
      active_ingestions_skipped: base.activeSkipped + perRun.activeSkipped,
      last_checked_updates: base.lastCheckedUpdates + perRun.lastCheckedUpdates,
      errors: errorsThisRun,
    };
    if (release) payload.claim_expires_at = null;
    await persistCrawlState(deps.db, deps.source.id, payload);
  }

  async function completeCycle(): Promise<CrawlCycleResult> {
    await persistCrawlState(deps.db, deps.source.id, {
      status: "idle",
      resume_state: {},
      claim_expires_at: null,
      last_cycle_completed_at: nowIso(),
      cycles_completed: claimedRow.cycles_completed + 1,
      pages_fetched: base.pages + perRun.pages,
      candidate_urls_seen: base.candidates + perRun.candidates,
      pending_ingestions_created: base.created + perRun.created,
      active_ingestions_skipped: base.activeSkipped + perRun.activeSkipped,
      last_checked_updates: base.lastCheckedUpdates + perRun.lastCheckedUpdates,
      errors: [],
    });
    return buildResult(true, "queue_drained");
  }

  for (;;) {
    if (nowMs() >= options.deadlineMs) {
      await checkpoint(true);
      return buildResult(false, "deadline");
    }

    if (state.phase === "crawl") {
      if (state.crawl_queue.length === 0) {
        state.phase = "scan";
        await checkpoint(false);
        continue;
      }

      const batch = state.crawl_queue.splice(0, crawlBatchSize);
      const pageResults = await mapWithConcurrency(
        batch,
        crawlBatchSize,
        async (item: CrawlQueueItem) => {
          try {
            return {
              item,
              page: await deps.fetchPage(item.url),
              fetchErr: null as string | null,
            };
          } catch (e) {
            return { item, page: null, fetchErr: (e as Error).message };
          }
        },
      );

      for (const { item, page, fetchErr } of pageResults) {
        if (fetchErr !== null) {
          errorsThisRun.push({ url: item.url, message: fetchErr });
          continue;
        }
        if (!page!.ok) {
          errorsThisRun.push({
            url: item.url,
            message: `HTTP ${page!.status}`,
          });
          continue;
        }
        perRun.pages += 1;

        for (const link of extractLinks(page!.html, item.url)) {
          const isTerminal = matchesAllowPattern(link, deps.source) ||
            looksLikeDocumentUrl(link);

          if (isTerminal) {
            if (seenCandidates.has(link)) continue;
            seenCandidates.add(link);
            if (
              resolveOwnerSourceId(link, deps.allSources) === deps.source.id
            ) {
              state.scan_queue.push(link);
            }
            continue;
          }

          if (
            shouldFollowLink(
              link,
              item.url,
              item.depth,
              deps.source,
              visited,
              maxPages,
            )
          ) {
            visited.add(link);
            state.crawl_queue.push({ url: link, depth: item.depth + 1 });
          }
        }
      }

      state.visited_urls = [...visited];
      state.seen_candidate_urls = [...seenCandidates];
      await checkpoint(false);
      continue;
    }

    // phase === "scan"
    if (state.scan_queue.length === 0) {
      return await completeCycle();
    }

    const scanBatch = state.scan_queue.splice(0, scanBatchSize);
    const scanResults = await mapWithConcurrency(
      scanBatch,
      scanBatchSize,
      (url: string) =>
        scanCandidateUrl(
          deps.db,
          url,
          deps.source.doc_type,
          deps.source.budget_stage ?? null,
          {
            fetchHead: deps.fetchHead,
            fetchHash: deps.fetchHash,
            newId,
            nowIso,
          },
        ).catch((e: Error): ScanResult => ({
          url,
          action: "error",
          message: e.message,
        })),
    );

    for (const result of scanResults) {
      perRun.candidates += 1;
      if (result.action === "pending_ingestion_created") perRun.created += 1;
      else if (result.action === "active_ingestion_exists") {
        perRun.activeSkipped += 1;
      } else if (result.action === "last_checked_updated") {
        perRun.lastCheckedUpdates += 1;
      } else if (result.action === "error") {
        errorsThisRun.push({
          url: result.url,
          message: result.message ?? "unknown error",
        });
      }
    }

    await checkpoint(false);
  }
}
