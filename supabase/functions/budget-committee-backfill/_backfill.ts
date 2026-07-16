import { generate as uuidv7 } from "@std/uuid/v7";
import {
  type DiscoverySource,
  type DocType,
  extractLinks,
  matchesAllowPattern,
  type PageFetchResult,
} from "../change-detection/_discovery.ts";
import {
  createPendingIngestionIfAbsent,
  type PendingIngestionInsert,
} from "../_shared/pending-ingestion.ts";

export interface BackfillQueueItem {
  url: string;
  depth: number;
}

export interface BackfillResumeState {
  version: 1;
  queue: BackfillQueueItem[];
  visited_urls: string[];
  seen_document_urls: string[];
}

export interface BackfillRunRow {
  id: string;
  source_id: string;
  doc_type: DocType;
  status: "in_progress" | "complete" | "failed";
  resume_state: BackfillResumeState;
  pages_fetched: number;
  candidate_urls_seen: number;
  pending_ingestions_created: number;
  active_ingestions_skipped: number;
  current_documents_skipped: number;
  errors: BackfillError[];
}

export interface BackfillError {
  url: string;
  message: string;
}

export interface BackfillResult {
  run_id: string;
  source_id: string;
  status: "in_progress" | "complete";
  reason: "soft_deadline" | "queue_drained" | "already_complete";
  pages_fetched_this_run: number;
  candidate_urls_seen_this_run: number;
  pending_ingestions_created_this_run: number;
  active_ingestions_skipped_this_run: number;
  current_documents_skipped_this_run: number;
  queue_remaining: number;
  totals: {
    pages_fetched: number;
    candidate_urls_seen: number;
    pending_ingestions_created: number;
    active_ingestions_skipped: number;
    current_documents_skipped: number;
    errors: number;
  };
}

export type PageFetcher = (url: string) => Promise<PageFetchResult>;

interface DbError {
  code?: string;
  message: string;
}

interface DbSingleResult<T> {
  data: T | null;
  error: DbError | null;
}

interface DbCountResult {
  count: number | null;
  error: DbError | null;
}

interface DbMutationResult {
  error: DbError | null;
}

interface RunSelectById {
  maybeSingle(): PromiseLike<DbSingleResult<BackfillRunRow>>;
}

interface RunSelectQuery {
  eq(column: "id", value: string): RunSelectById;
}

interface RunInsertQuery {
  select(columns: string): {
    single(): PromiseLike<DbSingleResult<BackfillRunRow>>;
  };
}

interface RunUpdateById {
  select(columns: string): {
    single(): PromiseLike<DbSingleResult<BackfillRunRow>>;
  };
}

interface RunUpdateQuery {
  eq(column: "id", value: string): RunUpdateById;
}

interface DiscoveryBackfillRunsTable {
  select(columns: string): RunSelectQuery;
  insert(payload: Record<string, unknown>): RunInsertQuery;
  update(payload: Record<string, unknown>): RunUpdateQuery;
}

interface CountQuery extends PromiseLike<DbCountResult> {
  eq(column: string, value: unknown): CountQuery;
  in(column: string, values: string[]): CountQuery;
}

interface CountTable {
  select(columns: string, opts: { count: "exact"; head: true }): CountQuery;
}

interface PendingIngestionsTable {
  insert(payload: PendingIngestionInsert): PromiseLike<DbMutationResult>;
}

export interface BackfillDb {
  from(table: "discovery_backfill_runs"): DiscoveryBackfillRunsTable;
  from(table: "documents"): CountTable;
  from(table: "pending_ingestions"): PendingIngestionsTable;
}

export interface BackfillOptions {
  runId?: string;
  minYear?: number;
  maxYear?: number;
  deadlineMs?: number;
  deadlineBufferMs?: number;
  requestDelayMs?: number;
  maxPages?: number;
  nowMs?: () => number;
  nowIso?: () => string;
  newId?: () => string;
}

export interface BackfillDeps {
  db: BackfillDb;
  source: DiscoverySource;
  fetchPage: PageFetcher;
}

const DEFAULT_RUN_ID = "budget_committee_meeting_historical_2008_2023";
const DEFAULT_MIN_YEAR = 2008;
const DEFAULT_MAX_YEAR = 2023;
const DEFAULT_DEADLINE_MS = 75_000;
const DEFAULT_DEADLINE_BUFFER_MS = 5_000;
const DEFAULT_REQUEST_DELAY_MS = 200;
const DEFAULT_MAX_PAGES = 500;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function initialResumeState(
  source: DiscoverySource,
): BackfillResumeState {
  return {
    version: 1,
    queue: source.discovery_urls.map((url) => ({ url, depth: 1 })),
    visited_urls: [...source.discovery_urls],
    seen_document_urls: [],
  };
}

function sameHostname(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

export function yearOfUrl(url: string): number | null {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const segmentMatch = pathname.match(/(?:^|\/)((?:19|20)\d{2})(?:\/|$)/);
    if (segmentMatch) return Number(segmentMatch[1]);

    const tokenMatch = pathname.match(
      /(?:^|[-_/])((?:19|20)\d{2})(?:[-_.\/]|$)/,
    );
    return tokenMatch ? Number(tokenMatch[1]) : null;
  } catch {
    return null;
  }
}

function inYearWindow(url: string, minYear: number, maxYear: number): boolean {
  const year = yearOfUrl(url);
  return year === null || (year >= minYear && year <= maxYear);
}

function isBudgetCommitteeArchivePage(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().includes(
      "budget-committee-meeting",
    );
  } catch {
    return false;
  }
}

function shouldFollowBackfillLink(
  link: string,
  pageUrl: string,
  depth: number,
  source: DiscoverySource,
  visited: Set<string>,
  minYear: number,
  maxYear: number,
  maxPages: number,
): boolean {
  if (depth >= source.discovery_depth) return false;
  if (visited.has(link)) return false;
  if (visited.size >= maxPages) return false;
  if (!sameHostname(link, pageUrl)) return false;
  if (
    source.discovery_link_prefix &&
    !link.startsWith(source.discovery_link_prefix)
  ) return false;
  if (matchesAllowPattern(link, source)) return false;
  if (!isBudgetCommitteeArchivePage(link)) return false;

  return inYearWindow(link, minYear, maxYear);
}

async function getRun(
  db: BackfillDb,
  runId: string,
): Promise<BackfillRunRow | null> {
  const { data, error } = await db
    .from("discovery_backfill_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();

  if (error) throw new Error(`Backfill run lookup failed: ${error.message}`);
  return data as BackfillRunRow | null;
}

async function createRun(
  db: BackfillDb,
  runId: string,
  source: DiscoverySource,
): Promise<BackfillRunRow> {
  const row = {
    id: runId,
    source_id: source.id,
    doc_type: source.doc_type,
    status: "in_progress",
    resume_state: initialResumeState(source),
    pages_fetched: 0,
    candidate_urls_seen: 0,
    pending_ingestions_created: 0,
    active_ingestions_skipped: 0,
    current_documents_skipped: 0,
    errors: [],
  };

  const { data, error } = await db
    .from("discovery_backfill_runs")
    .insert(row)
    .select("*")
    .single();

  if (error) throw new Error(`Backfill run insert failed: ${error.message}`);
  return data as BackfillRunRow;
}

async function persistRun(
  db: BackfillDb,
  run: BackfillRunRow,
  status: "in_progress" | "complete",
  nowIso: string,
): Promise<BackfillRunRow> {
  const { data, error } = await db
    .from("discovery_backfill_runs")
    .update({
      status,
      resume_state: run.resume_state,
      pages_fetched: run.pages_fetched,
      candidate_urls_seen: run.candidate_urls_seen,
      pending_ingestions_created: run.pending_ingestions_created,
      active_ingestions_skipped: run.active_ingestions_skipped,
      current_documents_skipped: run.current_documents_skipped,
      errors: run.errors,
      last_invoked_at: nowIso,
      completed_at: status === "complete" ? nowIso : null,
      last_error: null,
    })
    .eq("id", run.id)
    .select("*")
    .single();

  if (error) throw new Error(`Backfill run update failed: ${error.message}`);
  return data as BackfillRunRow;
}

async function hasCurrentDocument(
  db: BackfillDb,
  url: string,
  docType: DocType,
): Promise<boolean> {
  const { count, error } = await db
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("url", url)
    .eq("doc_type", docType)
    .eq("status", "current");

  if (error) {
    throw new Error(`Document lookup failed for ${url}: ${error.message}`);
  }
  return (count ?? 0) > 0;
}

function summarize(
  run: BackfillRunRow,
  status: "in_progress" | "complete",
  reason: BackfillResult["reason"],
  perRun: {
    pages: number;
    candidates: number;
    created: number;
    activeSkipped: number;
    currentSkipped: number;
  },
): BackfillResult {
  return {
    run_id: run.id,
    source_id: run.source_id,
    status,
    reason,
    pages_fetched_this_run: perRun.pages,
    candidate_urls_seen_this_run: perRun.candidates,
    pending_ingestions_created_this_run: perRun.created,
    active_ingestions_skipped_this_run: perRun.activeSkipped,
    current_documents_skipped_this_run: perRun.currentSkipped,
    queue_remaining: run.resume_state.queue.length,
    totals: {
      pages_fetched: run.pages_fetched,
      candidate_urls_seen: run.candidate_urls_seen,
      pending_ingestions_created: run.pending_ingestions_created,
      active_ingestions_skipped: run.active_ingestions_skipped,
      current_documents_skipped: run.current_documents_skipped,
      errors: run.errors.length,
    },
  };
}

export async function runBudgetCommitteeBackfill(
  deps: BackfillDeps,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  if (deps.source.id !== "budget_committee_meeting") {
    throw new Error(`Unsupported backfill source: ${deps.source.id}`);
  }

  const runId = options.runId ?? DEFAULT_RUN_ID;
  const minYear = options.minYear ?? DEFAULT_MIN_YEAR;
  const maxYear = options.maxYear ?? DEFAULT_MAX_YEAR;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const deadlineBufferMs = options.deadlineBufferMs ??
    DEFAULT_DEADLINE_BUFFER_MS;
  const requestDelayMs = options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const nowMs = options.nowMs ?? (() => Date.now());
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => uuidv7());
  const startMs = nowMs();
  const softStopMs = startMs + Math.max(0, deadlineMs - deadlineBufferMs);

  let run = await getRun(deps.db, runId);
  if (!run) run = await createRun(deps.db, runId, deps.source);

  if (run.status === "complete") {
    return summarize(run, "complete", "already_complete", {
      pages: 0,
      candidates: 0,
      created: 0,
      activeSkipped: 0,
      currentSkipped: 0,
    });
  }

  const visited = new Set(run.resume_state.visited_urls);
  const seenDocuments = new Set(run.resume_state.seen_document_urls);
  const perRun = {
    pages: 0,
    candidates: 0,
    created: 0,
    activeSkipped: 0,
    currentSkipped: 0,
  };

  while (run.resume_state.queue.length > 0) {
    if (nowMs() >= softStopMs) {
      run.resume_state.visited_urls = [...visited];
      run.resume_state.seen_document_urls = [...seenDocuments];
      run = await persistRun(deps.db, run, "in_progress", nowIso());
      return summarize(run, "in_progress", "soft_deadline", perRun);
    }

    const item = run.resume_state.queue.shift()!;
    await sleep(requestDelayMs);

    let page: PageFetchResult;
    try {
      page = await deps.fetchPage(item.url);
    } catch (e) {
      run.errors.push({ url: item.url, message: (e as Error).message });
      run.resume_state.visited_urls = [...visited];
      run.resume_state.seen_document_urls = [...seenDocuments];
      run = await persistRun(deps.db, run, "in_progress", nowIso());
      continue;
    }

    run.pages_fetched += 1;
    perRun.pages += 1;

    if (!page.ok) {
      run.errors.push({ url: item.url, message: `HTTP ${page.status}` });
      run.resume_state.visited_urls = [...visited];
      run.resume_state.seen_document_urls = [...seenDocuments];
      run = await persistRun(deps.db, run, "in_progress", nowIso());
      continue;
    }

    for (const link of extractLinks(page.html, item.url)) {
      if (
        matchesAllowPattern(link, deps.source) &&
        inYearWindow(link, minYear, maxYear)
      ) {
        if (seenDocuments.has(link)) continue;
        seenDocuments.add(link);
        run.candidate_urls_seen += 1;
        perRun.candidates += 1;

        if (await hasCurrentDocument(deps.db, link, deps.source.doc_type)) {
          run.current_documents_skipped += 1;
          perRun.currentSkipped += 1;
        } else {
          const pendingId = await createPendingIngestionIfAbsent(deps.db, {
            id: newId(),
            url: link,
            docType: deps.source.doc_type,
            nowIso: nowIso(),
          });

          if (pendingId) {
            run.pending_ingestions_created += 1;
            perRun.created += 1;
          } else {
            run.active_ingestions_skipped += 1;
            perRun.activeSkipped += 1;
          }
        }

        continue;
      }

      if (
        shouldFollowBackfillLink(
          link,
          item.url,
          item.depth,
          deps.source,
          visited,
          minYear,
          maxYear,
          maxPages,
        )
      ) {
        visited.add(link);
        run.resume_state.queue.push({ url: link, depth: item.depth + 1 });
      }
    }

    run.resume_state.visited_urls = [...visited];
    run.resume_state.seen_document_urls = [...seenDocuments];
    run = await persistRun(deps.db, run, "in_progress", nowIso());
  }

  run.resume_state.visited_urls = [...visited];
  run.resume_state.seen_document_urls = [...seenDocuments];
  run = await persistRun(deps.db, run, "complete", nowIso());
  return summarize(run, "complete", "queue_drained", perRun);
}
