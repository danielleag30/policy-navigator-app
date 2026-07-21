/**
 * Resumable, checkpointed OCR pre-ingestion for the 18 EnCode historical
 * zoning-ordinance reprints (see _shared/encode-zoning-reprints.ts's
 * ENCODE_ZONING_REPRINTS -- the single source of truth this module reads
 * rather than redefining).
 *
 * WHY THIS EXISTS: query-pipeline/_deep-historical.ts's live-lookup slow
 * path (PR #109) can never produce a real answer as-is -- the docling-wrapper
 * endpoint it called was always do_ocr=False, and all 18 reprints are pure
 * scanned images with zero embedded text, so extraction always returned 0
 * blocks. This job walks all 18 reprints ahead of time against the new
 * OCR-enabled Tier 0 opt-in endpoint (docling-wrapper's POST /process-ocr,
 * see that file's header) and persists real extracted page text, so most
 * queries answer from a fast DB lookup instead of paying for live OCR on
 * every matching query. _deep-historical.ts checks this store first
 * (fetchPreingestedReprintBlocks) and only falls back to a live OCR fetch
 * for a reprint this job hasn't finished yet.
 *
 * PATTERN: mirrors change-detection/_crawl_state.ts's resumable per-source
 * crawl (persisted cursor + status, atomic claim lease so two overlapping
 * cron ticks can never double-process the same reprint) and municode.ts's
 * deadline-aware queue drain (loop with a deadline check before each unit of
 * work, checkpoint after each unit, release the lease immediately on a
 * deadline exit rather than waiting out the full lease window). One unit of
 * work here = one page-chunk OCR call.
 *
 * Each reprint's document is fetched in full by the Tier 0 wrapper on every
 * chunk call (the wrapper is stateless across requests) and sliced
 * server-side with poppler-utils to just the requested page range before
 * OCR -- see docling-wrapper/app.py's /process-ocr for why. That repeated
 * download is an accepted cost: each of the 18 documents is walked to
 * completion exactly once, ever, after which its preingest_state row never
 * needs revisiting.
 *
 * COMPLIANCE: reuses the same ENCODE_ZONING_ENABLED gate as
 * ingest-orchestrator/encode.ts and query-pipeline/_deep-historical.ts (see
 * that file's header) -- a legal/human sign-off revocation shuts off every
 * EnCode-touching path at once. No network request and no DB write happens
 * here unless the gate is exactly "true".
 */

import { generate as uuidv7 } from "@std/uuid/v7";
import type { FlatBlock } from "../_shared/chunker.ts";
import {
  type DeepHistoricalReprint,
  ENCODE_ZONING_REPRINTS,
  reprintDocUrl,
} from "../_shared/encode-zoning-reprints.ts";

// ── DB shape ──────────────────────────────────────────────────────────────────

export interface DbError {
  message: string;
}

export type PreingestStatus = "pending" | "in_progress" | "complete";

export interface PreingestStateRow {
  doc_library_id: string;
  reprint_label: string;
  reprint_year: number;
  status: PreingestStatus;
  total_pages: number | null;
  next_page: number;
  pages_completed: number;
  claim_expires_at: string | null;
  last_invoked_at: string;
  last_error: string | null;
  completed_at: string | null;
}

interface MaybeSingleResult<T> {
  data: T | null;
  error: DbError | null;
}

interface StateUpdateChain {
  eq(column: "doc_library_id", value: string): StateUpdateChain;
  or(condition: string): StateUpdateChain;
  select(columns: string): {
    maybeSingle(): PromiseLike<MaybeSingleResult<PreingestStateRow>>;
  };
}

interface StateSelectChain {
  neq(column: "status", value: string): {
    order(column: string, opts: { ascending: boolean }): PromiseLike<
      { data: PreingestStateRow[] | null; error: DbError | null }
    >;
  };
}

interface StateTable {
  update(payload: Record<string, unknown>): StateUpdateChain;
  select(columns: string): StateSelectChain;
  upsert(
    rows: Record<string, unknown>[],
    opts: { onConflict: string; ignoreDuplicates?: boolean },
  ): PromiseLike<{ error: DbError | null }>;
}

interface PagesTable {
  upsert(
    rows: Record<string, unknown>[],
    opts: { onConflict: string },
  ): PromiseLike<{ error: DbError | null }>;
}

/** Minimal shape this module needs from a supabase-js client — narrow on
 * purpose so tests can pass an in-memory fake instead of a real db client. */
export interface EncodeReprintDb {
  from(table: "encode_reprint_preingest_state"): StateTable;
  from(table: "encode_reprint_pages"): PagesTable;
}

// ── Seeding (idempotent, sourced from the shared reprint table) ────────────────

/**
 * Upsert one encode_reprint_preingest_state row per ENCODE_ZONING_REPRINTS
 * entry, ignoring rows that already exist. Run at the start of every
 * invocation instead of via a migration seed, so the 18-reprint list stays
 * single-sourced in _shared/encode-zoning-reprints.ts (see that file's
 * header) rather than duplicated in SQL.
 */
export async function ensureStateRows(db: EncodeReprintDb): Promise<void> {
  const rows = ENCODE_ZONING_REPRINTS.map((r) => ({
    doc_library_id: r.docLibraryId,
    reprint_label: r.label,
    reprint_year: r.year,
  }));
  const { error } = await db
    .from("encode_reprint_preingest_state")
    .upsert(rows, { onConflict: "doc_library_id", ignoreDuplicates: true });
  if (error) {
    throw new Error(
      `encode_reprint_preingest_state seed upsert failed: ${error.message}`,
    );
  }
}

export async function listIncompleteReprints(
  db: EncodeReprintDb,
): Promise<PreingestStateRow[]> {
  const { data, error } = await db
    .from("encode_reprint_preingest_state")
    .select("*")
    .neq("status", "complete")
    .order("last_invoked_at", { ascending: true });
  if (error) {
    throw new Error(
      `encode_reprint_preingest_state list failed: ${error.message}`,
    );
  }
  return data ?? [];
}

export const DEFAULT_LEASE_MINUTES = 5;

/**
 * Atomically claims a reprint's row for the duration of this invocation's
 * work on it: a conditional UPDATE ... WHERE claim_expires_at IS NULL OR
 * claim_expires_at < now() ... RETURNING, the same shape proven by
 * claimSource() in change-detection/_crawl_state.ts and
 * findResumableDocument() in ingest-orchestrator/municode.ts. Returns null
 * if another invocation already holds an unexpired lease on this reprint —
 * the caller must skip it this tick rather than risk double-processing its
 * page cursor.
 */
export async function claimReprint(
  db: EncodeReprintDb,
  docLibraryId: string,
  options: {
    leaseMinutes?: number;
    nowMs?: () => number;
    nowIso?: () => string;
  } = {},
): Promise<PreingestStateRow | null> {
  const leaseMinutes = options.leaseMinutes ?? DEFAULT_LEASE_MINUTES;
  const nowMs = options.nowMs ?? (() => Date.now());
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const nowIsoStr = nowIso();
  const leaseExpiresAt = new Date(nowMs() + leaseMinutes * 60 * 1000)
    .toISOString();

  const { data, error } = await db
    .from("encode_reprint_preingest_state")
    .update({
      claim_expires_at: leaseExpiresAt,
      last_invoked_at: nowIsoStr,
      status: "in_progress",
    })
    .eq("doc_library_id", docLibraryId)
    .or(`claim_expires_at.is.null,claim_expires_at.lt.${nowIsoStr}`)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(
      `encode_reprint_preingest_state claim failed for ${docLibraryId}: ${error.message}`,
    );
  }
  return data;
}

async function persistState(
  db: EncodeReprintDb,
  docLibraryId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from("encode_reprint_preingest_state")
    .update(patch)
    .eq("doc_library_id", docLibraryId)
    .select("doc_library_id")
    .maybeSingle();
  if (error) {
    throw new Error(
      `encode_reprint_preingest_state update failed for ${docLibraryId}: ${error.message}`,
    );
  }
}

// ── Page grouping ────────────────────────────────────────────────────────────

export interface PageRow {
  page_number: number;
  text: string;
}

/**
 * Group a chunk's OCR'd blocks by page, joining a page's blocks (in reading
 * order) into that page's full text. Pages with only whitespace/empty text
 * after OCR (a genuinely blank page, or a page_no Docling couldn't
 * determine) are dropped — the resume cursor still advances past them, but
 * no encode_reprint_pages row is written for them (see file header of the
 * migration for why this is sparse by design).
 */
export function groupBlocksIntoPageRows(blocks: FlatBlock[]): PageRow[] {
  const byPage = new Map<number, string[]>();
  const sorted = [...blocks].sort(
    (a, b) => a.reading_order_index - b.reading_order_index,
  );
  for (const block of sorted) {
    if (block.page_no === null) continue;
    const texts = byPage.get(block.page_no) ?? [];
    texts.push(block.text);
    byPage.set(block.page_no, texts);
  }

  return [...byPage.entries()]
    .map(([page_number, texts]): PageRow => ({
      page_number,
      text: texts.join(" ").trim(),
    }))
    .filter((row) => row.text.length > 0)
    .sort((a, b) => a.page_number - b.page_number);
}

async function upsertPages(
  db: EncodeReprintDb,
  docLibraryId: string,
  pages: PageRow[],
  newId: () => string,
): Promise<void> {
  if (pages.length === 0) return;
  const rows = pages.map((p) => ({
    id: newId(),
    doc_library_id: docLibraryId,
    page_number: p.page_number,
    text: p.text,
  }));
  const { error } = await db
    .from("encode_reprint_pages")
    .upsert(rows, { onConflict: "doc_library_id,page_number" });
  if (error) {
    throw new Error(
      `encode_reprint_pages upsert failed for ${docLibraryId}: ${error.message}`,
    );
  }
}

// ── Tier 0 wrapper calls ─────────────────────────────────────────────────────

export const DEFAULT_PAGES_PER_CHUNK = 3;
export const DEFAULT_PDFINFO_TIMEOUT_MS = 30_000;
// Mirrors _deep-historical.ts's DEFAULT_DOCLING_TIMEOUT_MS (110s) — same
// OCR-enabled endpoint, same CPU-bound cost per page.
export const DEFAULT_OCR_CHUNK_TIMEOUT_MS = 110_000;
/** Polite delay between successive Tier 0 calls within one invocation. */
const REQUEST_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FetchPageCount = (sourceUrl: string) => Promise<number>;
export type FetchOcrChunk = (
  sourceUrl: string,
  pageStart: number,
  pageEnd: number,
) => Promise<FlatBlock[]>;

export function buildFetchPageCount(
  doclingUrl: string,
  timeoutMs: number = DEFAULT_PDFINFO_TIMEOUT_MS,
): FetchPageCount {
  return async (sourceUrl: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${doclingUrl.replace(/\/$/, "")}/pdfinfo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`pdfinfo wrapper returned HTTP ${resp.status}`);
      }
      const payload = await resp.json() as { pages: number };
      return payload.pages;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(
          `pdfinfo call timed out after ${Math.ceil(timeoutMs / 1000)}s`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function buildFetchOcrChunk(
  doclingUrl: string,
  timeoutMs: number = DEFAULT_OCR_CHUNK_TIMEOUT_MS,
): FetchOcrChunk {
  return async (sourceUrl: string, pageStart: number, pageEnd: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(
        `${doclingUrl.replace(/\/$/, "")}/process-ocr`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: sourceUrl,
            page_start: pageStart,
            page_end: pageEnd,
          }),
          signal: controller.signal,
        },
      );
      if (!resp.ok) {
        throw new Error(`process-ocr wrapper returned HTTP ${resp.status}`);
      }
      const payload = await resp.json() as { blocks: FlatBlock[] };
      return payload.blocks ?? [];
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(
          `process-ocr call timed out after ${Math.ceil(timeoutMs / 1000)}s`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface EncodeReprintPreingestDeps {
  db: EncodeReprintDb;
  fetchPageCount: FetchPageCount;
  fetchOcrChunk: FetchOcrChunk;
}

export interface EncodeReprintPreingestOptions {
  /** Absolute epoch-ms deadline for this invocation's total work. */
  deadlineMs: number;
  pagesPerChunk?: number;
  leaseMinutes?: number;
  nowMs?: () => number;
  nowIso?: () => string;
  newId?: () => string;
}

export interface ReprintWorkResult {
  docLibraryId: string;
  label: string;
  status: "complete" | "in_progress" | "leased";
  pagesCompletedThisRun: number;
  totalPages: number | null;
  reason?: "deadline" | "leased" | "error";
  error?: string;
}

export interface EncodeReprintPreingestResult {
  processedReprints: ReprintWorkResult[];
  reason:
    | "deadline"
    | "all_complete"
    | "no_claimable_reprint"
    | "error"
    | "compliance_gate_disabled";
}

export interface ProcessReprintOptions {
  /** Absolute epoch-ms deadline for this invocation's total work. */
  deadlineMs: number;
  pagesPerChunk: number;
  nowMs: () => number;
  nowIso: () => string;
  newId: () => string;
}

/**
 * Work one claimed reprint: fetch its total page count if not already
 * known, then loop page-chunks (checking the deadline before each one,
 * checkpointing the resume cursor after each one) until either the whole
 * document is done or the deadline is hit. Mirrors municode.ts's
 * drainQueue() — bounded work per invocation, resumable via the persisted
 * cursor, release the claim lease immediately on any exit so the next
 * invocation can pick this reprint straight back up.
 *
 * Exported (unlike the rest of runEncodeReprintPreingest's internals) so
 * tests can exercise the resume-cursor and page-chunking logic directly
 * against one claimed row, independent of the 18-reprint claim/rotation
 * loop runEncodeReprintPreingest owns.
 */
export async function processOneReprint(
  deps: EncodeReprintPreingestDeps,
  claimed: PreingestStateRow,
  options: ProcessReprintOptions,
): Promise<ReprintWorkResult> {
  const { db, fetchPageCount, fetchOcrChunk } = deps;
  const { deadlineMs, pagesPerChunk, nowMs, nowIso, newId } = options;

  const reprint: DeepHistoricalReprint = {
    label: claimed.reprint_label,
    year: claimed.reprint_year,
    docLibraryId: claimed.doc_library_id,
  };
  const sourceUrl = reprintDocUrl(reprint);

  async function releaseWithError(reason: string): Promise<ReprintWorkResult> {
    await persistState(db, claimed.doc_library_id, {
      status: "in_progress",
      claim_expires_at: null,
      last_error: reason,
      last_invoked_at: nowIso(),
    });
    return {
      docLibraryId: claimed.doc_library_id,
      label: claimed.reprint_label,
      status: "in_progress",
      pagesCompletedThisRun: 0,
      totalPages: claimed.total_pages,
      reason: "error",
      error: reason,
    };
  }

  let totalPages = claimed.total_pages;
  if (totalPages === null) {
    try {
      totalPages = await fetchPageCount(sourceUrl);
    } catch (e) {
      console.error(
        `[encode-reprint-preingest] pdfinfo failed for ${claimed.doc_library_id}: ${
          (e as Error).message
        }`,
      );
      return await releaseWithError((e as Error).message);
    }
    await persistState(db, claimed.doc_library_id, {
      total_pages: totalPages,
      last_invoked_at: nowIso(),
      last_error: null,
    });
    await sleep(REQUEST_DELAY_MS);
  }

  let nextPage = claimed.next_page;
  let cumulativePagesCompleted = claimed.pages_completed;
  let pagesCompletedThisRun = 0;

  while (nextPage <= totalPages) {
    if (nowMs() >= deadlineMs) {
      await persistState(db, claimed.doc_library_id, {
        status: "in_progress",
        claim_expires_at: null,
        last_invoked_at: nowIso(),
      });
      return {
        docLibraryId: claimed.doc_library_id,
        label: claimed.reprint_label,
        status: "in_progress",
        pagesCompletedThisRun,
        totalPages,
        reason: "deadline",
      };
    }

    const chunkStart = nextPage;
    const chunkEnd = Math.min(nextPage + pagesPerChunk - 1, totalPages);

    let blocks: FlatBlock[];
    try {
      blocks = await fetchOcrChunk(sourceUrl, chunkStart, chunkEnd);
    } catch (e) {
      console.error(
        `[encode-reprint-preingest] OCR chunk ${chunkStart}-${chunkEnd} failed for ${claimed.doc_library_id}: ${
          (e as Error).message
        }`,
      );
      return await releaseWithError((e as Error).message);
    }

    const pageRows = groupBlocksIntoPageRows(blocks);
    await upsertPages(db, claimed.doc_library_id, pageRows, newId);

    const chunkPageCount = chunkEnd - chunkStart + 1;
    nextPage = chunkEnd + 1;
    cumulativePagesCompleted += chunkPageCount;
    pagesCompletedThisRun += chunkPageCount;

    const reachedEnd = nextPage > totalPages;
    await persistState(db, claimed.doc_library_id, {
      next_page: nextPage,
      pages_completed: cumulativePagesCompleted,
      status: reachedEnd ? "complete" : "in_progress",
      completed_at: reachedEnd ? nowIso() : null,
      claim_expires_at: reachedEnd ? null : claimed.claim_expires_at,
      last_invoked_at: nowIso(),
      last_error: null,
    });

    console.log(
      `[encode-reprint-preingest] ${claimed.doc_library_id}: OCR'd pages ${chunkStart}-${chunkEnd}/${totalPages}, ${pageRows.length} page(s) with text`,
    );

    if (reachedEnd) {
      return {
        docLibraryId: claimed.doc_library_id,
        label: claimed.reprint_label,
        status: "complete",
        pagesCompletedThisRun,
        totalPages,
      };
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // totalPages was 0 or next_page already exceeded it on claim (shouldn't
  // normally happen, but treat as complete rather than looping forever).
  await persistState(db, claimed.doc_library_id, {
    status: "complete",
    completed_at: nowIso(),
    claim_expires_at: null,
    last_invoked_at: nowIso(),
  });
  return {
    docLibraryId: claimed.doc_library_id,
    label: claimed.reprint_label,
    status: "complete",
    pagesCompletedThisRun,
    totalPages,
  };
}

/**
 * Run the pre-ingestion job for as long as this invocation's deadline
 * allows: seed any missing state rows, then repeatedly claim the
 * least-recently-attempted incomplete reprint and work it (potentially to
 * completion, if it's small enough to finish within the remaining budget)
 * before moving to the next one. A reprint whose lease is already held by a
 * concurrent invocation is skipped for this tick rather than retried in a
 * loop.
 */
export async function runEncodeReprintPreingest(
  deps: EncodeReprintPreingestDeps,
  options: EncodeReprintPreingestOptions,
): Promise<EncodeReprintPreingestResult> {
  if (Deno.env.get("ENCODE_ZONING_ENABLED") !== "true") {
    return { processedReprints: [], reason: "compliance_gate_disabled" };
  }

  const nowMs = options.nowMs ?? (() => Date.now());
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => uuidv7());
  const pagesPerChunk = options.pagesPerChunk ?? DEFAULT_PAGES_PER_CHUNK;
  const leaseMinutes = options.leaseMinutes ?? DEFAULT_LEASE_MINUTES;

  await ensureStateRows(deps.db);

  const results: ReprintWorkResult[] = [];
  const skipThisTick = new Set<string>();

  while (true) {
    if (nowMs() >= options.deadlineMs) {
      return { processedReprints: results, reason: "deadline" };
    }

    const incomplete = (await listIncompleteReprints(deps.db)).filter(
      (row) => !skipThisTick.has(row.doc_library_id),
    );
    if (incomplete.length === 0) {
      const reason = skipThisTick.size > 0
        ? "no_claimable_reprint"
        : "all_complete";
      return { processedReprints: results, reason };
    }

    const candidate = incomplete[0];
    const claimed = await claimReprint(deps.db, candidate.doc_library_id, {
      leaseMinutes,
      nowMs,
      nowIso,
    });
    if (!claimed) {
      skipThisTick.add(candidate.doc_library_id);
      results.push({
        docLibraryId: candidate.doc_library_id,
        label: candidate.reprint_label,
        status: "leased",
        pagesCompletedThisRun: 0,
        totalPages: candidate.total_pages,
        reason: "leased",
      });
      continue;
    }

    const workResult = await processOneReprint(deps, claimed, {
      deadlineMs: options.deadlineMs,
      pagesPerChunk,
      nowMs,
      nowIso,
      newId,
    });
    results.push(workResult);

    if (workResult.status !== "complete") {
      // Deadline hit or an error mid-reprint — already checkpointed and the
      // lease already released; stop this invocation rather than starting a
      // fresh reprint with whatever budget (if any) remains.
      return {
        processedReprints: results,
        reason: workResult.reason === "deadline" ? "deadline" : "error",
      };
    }
    // Completed with time to spare — loop to claim the next incomplete reprint.
  }
}
