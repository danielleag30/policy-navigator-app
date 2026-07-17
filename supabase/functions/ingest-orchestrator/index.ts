/**
 * ingest-orchestrator — Ingestion Orchestrator Edge Function
 *
 * Entry point for the Policy Navigator document ingestion pipeline.
 * Implements tasks 2-1, 2-3, 2-4, 2-5, and 2-6.
 *
 * Request body: { pending_ingestion_id: string }
 *
 * Flow:
 *  1. Fetch PendingIngestion row (status = 'pending' only)
 *  2. Set status = 'processing', increment attempts, set next_attempt_at
 *  3. Branch on doc_type:
 *     PDF types → pdfBranch() (task 2-3)
 *     municode_api → municodeBranch() (task 2-5)
 *  4. PDF: content_hash dedup, Document shell, Docling call, chunker,
 *     document_chunks insert, LLM extraction (task 2-4)
 *  5. Both branches: pre-flight AI Session check, embedding generation,
 *     document finalization (task 2-6)
 *  6. Municode only: PendingCodeChange overlap check, reconciliation trigger
 *  7. On error: PendingAlert; after 3 failures set status = 'failed'
 *
 * No stack traces are exposed in any response.
 */

import "@supabase/functions-js/edge-runtime.d.ts";
import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { error, success } from "../_shared/response.ts";
import { contentHash } from "../_shared/hash.ts";
import {
  type Chunk,
  chunkBlocks,
  type FlatBlock,
  validateTokenizer,
} from "../_shared/chunker.ts";
import { extractAndPersist } from "../_shared/extractor.ts";
import {
  type AiSession,
  generateEmbeddingsHttpBatched,
  persistEmbeddings,
  preflight,
} from "../_shared/embedder.ts";
import {
  handleMunicode,
  handleMunicodeHistoricalBackfill,
  handleMunicodeHistoricalEmbeddingRetry,
} from "./municode.ts";
import { handleEncode } from "./encode.ts";
import {
  embedOrdinanceProvisionsBatched,
  ORDINANCE_EMBED_FETCH_PAGE_SIZE,
} from "./ordinance-embedder.ts";
import { requestSecret } from "../_shared/admin-auth.ts";
import {
  type ClaimedPendingIngestion,
  type ClaimNextResult,
  type PendingIngestionClaim,
  runPendingIngestionLoop,
} from "./_multi-row-loop.ts";
import { recordAiSessionDeferredPendingAlert } from "../_shared/pending-alerts.ts";
import {
  type ReconciliationTriggerDb,
  triggerReconciliationIfNeeded,
} from "./_reconciliation-trigger.ts";

// Supabase.ai.Session is injected by the Edge Function runtime.
// Declare here so TypeScript resolves it; actual availability is checked at runtime.
declare const Supabase: {
  ai: { Session: new (model: string) => AiSession };
};

// ── Constants ─────────────────────────────────────────────────────────────────

const PDF_DOC_TYPES = ["bos_minutes", "bos_summary", "budget_pdf"] as const;

/** Exponential backoff schedule (minutes) indexed by attempt number (1-based). */
const BACKOFF_MINUTES: Record<number, number> = { 1: 1, 2: 5, 3: 30 };

/** Absolute retry ceiling — skip the row when newAttempts exceeds this. */
const ABSOLUTE_MAX_ATTEMPTS = 50;

/**
 * After this many Docling HTTP 500 attempts the PDF is considered too large
 * for the free-tier HF Spaces instance; skip rather than retry forever.
 */
const DOCLING_500_MAX_ATTEMPTS = 10;

/** When Supabase AI Session is unavailable, defer for this many minutes. */
const AI_SESSION_DEFER_MINUTES = 15;

/**
 * Hard-abort budget for the raw source-PDF fetch (content-hash step), in ms.
 * Kept stable because tests and retry classification rely on the exact
 * timeout message; poll mode bounds the following Docling call instead.
 */
const SOURCE_FETCH_TIMEOUT_MS = 20_000;

/**
 * Default Docling timeout for explicit/admin single-row processing. Poll mode
 * clamps this to the per-row PDF budget below.
 */
const DOCLING_TIMEOUT_MS = 100_000;

/**
 * Poll mode processes rows sequentially and stops claiming fresh work well
 * before the platform's CPU resource ceiling. The 80s claim window allows a
 * small number of bounded PDF rows per invocation with margin under the
 * observed ~108s CPU failure point, while fast duplicate/API rows can still
 * drain opportunistically.
 */
const POLL_CLAIM_WINDOW_MS = 80_000;

/**
 * PDFs are the expensive path. Bound each PDF row in cron/poll mode so one slow
 * Docling/source fetch cannot turn a multi-row invocation into a resource-limit
 * crash. Explicit pending_ingestion_id calls still receive the full soft
 * deadline for targeted one-off work.
 *
 * Matches DOCLING_TIMEOUT_MS rather than a shorter poll-specific figure:
 * live production data showed real bos_minutes/bos_summary/budget_pdf
 * conversions (~400KB-1MB, no OCR/table-structure) routinely running past
 * 30s, so the previous 35_000 value here made poll mode -- the only path that
 * processes real cron traffic -- time out on nearly every PDF regardless of
 * size (last_error consistently "Docling call timed out after 29s"/"30s").
 * The ~108s CPU failure point referenced above came from stacking multiple
 * rows' local Supabase.ai.Session embedding calls (CPU-bound) in one
 * invocation; now that all PDF-branch embedding runs over HTTP instead (see
 * embedDocumentChunks and friends below, same fix PR #83 applied to
 * ordinance_provisions), that CPU accumulation no longer happens per row, so
 * the Docling wall-clock budget can go back to matching the single-row value.
 */
const POLL_PDF_ROW_BUDGET_MS = DOCLING_TIMEOUT_MS;

/**
 * Time reserved after a Docling response for chunking, extraction, embeddings,
 * and status updates. This is not a hard guarantee, but it keeps Docling from
 * consuming all of a row's per-row budget.
 */
const PDF_POST_DOCLING_BUFFER_MS = 5_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function nextAttemptAt(attempt: number): string {
  const minutes = BACKOFF_MINUTES[attempt] ?? 30;
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function writePendingAlert(
  pendingIngestionId: string,
  message: string,
): Promise<void> {
  const { error: alertErr } = await db.from("pending_alerts").insert({
    id: uuidv7(),
    alert_type: "ingestion_failure" as const,
    details: { pending_ingestion_id: pendingIngestionId, message },
    triggered_at: new Date().toISOString(),
  });
  if (alertErr) {
    throw new Error(`Failed to write PendingAlert: ${alertErr.message}`);
  }
}

/**
 * Undo the attempt increment and reset status to 'pending' with an extended
 * next_attempt_at.  Used when the AI Session is not yet available so the
 * deferral does not consume a retry budget entry.
 */
async function deferIngestion(
  pendingIngestionId: string,
  currentAttempts: number,
  reason: string,
): Promise<Response> {
  const { error: deferErr } = await db
    .from("pending_ingestions")
    .update({
      status: "pending",
      attempts: currentAttempts - 1,
      next_attempt_at: new Date(
        Date.now() + AI_SESSION_DEFER_MINUTES * 60 * 1000,
      ).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", pendingIngestionId);
  if (deferErr) {
    // Cannot guarantee the no-retry contract without the DB write succeeding.
    // Throw so the outer catch resets the row to 'pending' rather than leaving it stuck in 'processing'.
    throw new Error(
      `Defer-without-retry DB update failed (${reason}): ${deferErr.message}`,
    );
  }
  await recordAiSessionDeferredPendingAlert(db, pendingIngestionId, reason);
  console.warn(`[orchestrator] deferred ingestion: ${reason}`);
  return success({ status: "deferred", reason: "ai_session_unavailable" });
}

/**
 * Requeue a Municode ingestion that paused mid-walk after hitting the soft
 * deadline. Not a failure — the walk's resume state was already persisted
 * to documents.municode_resume_state by handleMunicode(), so this just
 * undoes the attempt-count consumption and schedules an immediate retry so
 * the next invocation (cron poll or manual) picks the walk back up.
 */
async function requeueForResume(
  pendingIngestionId: string,
  currentAttempts: number,
  logMessage: string =
    "[orchestrator] Municode soft deadline hit — requeued for resume",
): Promise<Response> {
  const { error: requeueErr } = await db
    .from("pending_ingestions")
    .update({
      status: "pending",
      attempts: currentAttempts - 1,
      next_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", pendingIngestionId);
  if (requeueErr) {
    throw new Error(`Resume requeue DB update failed: ${requeueErr.message}`);
  }
  console.log(logMessage);
  return success({
    status: "in_progress",
    reason: "soft_deadline_resume_scheduled",
  });
}

// ── PDF branch (tasks 2-3, 2-4) ───────────────────────────────────────────────

interface PdfBranchResult {
  documentId: string;
  chunks: Chunk[];
  doclingVersion: string;
  skipped: boolean;
}

async function pdfBranch(
  pendingIngestionId: string,
  sourceUrl: string,
  docType: string,
  deadlineMs?: number,
): Promise<PdfBranchResult> {
  const doclingUrl = Deno.env.get("HF_SPACES_DOCLING_URL");
  if (!doclingUrl) throw new Error("HF_SPACES_DOCLING_URL not set");

  const remainingMs = () =>
    deadlineMs === undefined
      ? Number.POSITIVE_INFINITY
      : deadlineMs - Date.now();
  const boundedTimeoutMs = (
    requestedMs: number,
    reserveMs = 0,
  ): number => {
    const remaining = remainingMs();
    if (!Number.isFinite(remaining)) return requestedMs;
    return Math.max(1_000, Math.min(requestedMs, remaining - reserveMs));
  };

  // 1. Fetch source PDF bytes for content_hash — hard-abort well before the
  // wall-clock kill so a slow/hanging source host can't burn the whole ~150s
  // budget before execution ever reaches the (already time-boxed) Docling call.
  let pdfBytes: Uint8Array;
  const sourceFetchController = new AbortController();
  const sourceFetchTimer = setTimeout(
    () => sourceFetchController.abort(),
    SOURCE_FETCH_TIMEOUT_MS,
  );
  try {
    const resp = await fetch(sourceUrl, {
      redirect: "follow",
      signal: sourceFetchController.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching source PDF`);
    pdfBytes = new Uint8Array(await resp.arrayBuffer());
  } catch (e) {
    if (
      e instanceof DOMException && (e as DOMException).name === "AbortError"
    ) {
      throw new Error(
        `Source PDF fetch timed out after ${SOURCE_FETCH_TIMEOUT_MS / 1000}s`,
      );
    }
    throw new Error(`Source fetch failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(sourceFetchTimer);
  }

  // 2. Compute content_hash; check for duplicate
  const hash = await contentHash(pdfBytes);

  const { data: existing, error: lookupErr } = await db
    .from("documents")
    .select("id, status")
    .eq("content_hash", hash)
    .eq("status", "current")
    .maybeSingle();

  if (lookupErr) throw new Error(`Dedup lookup failed: ${lookupErr.message}`);

  if (existing) {
    const { error: skipErr } = await db
      .from("pending_ingestions")
      .update({ status: "skipped", updated_at: new Date().toISOString() })
      .eq("id", pendingIngestionId);
    if (skipErr) {
      throw new Error(
        `Failed to mark ingestion as skipped: ${skipErr.message}`,
      );
    }
    console.log(`[pdf-branch] duplicate content_hash ${hash} — skipped`);
    return {
      documentId: existing.id,
      chunks: [],
      doclingVersion: "",
      skipped: true,
    };
  }

  // 3. Remove any orphaned shell left by a prior failed attempt, then insert fresh.
  // Without this, a retry hits the unique constraint on documents.url when an
  // earlier run created a status='unknown' row that the content_hash dedup above
  // won't find (it only matches status='current').
  // Children must be deleted before the parent to avoid FK violations.
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: orphanDocs } = await db
    .from("documents")
    .select("id")
    .eq("url", sourceUrl)
    .eq("status", "unknown")
    .lt("created_at", fiveMinutesAgo);

  if (orphanDocs && orphanDocs.length > 0) {
    const orphanIds = orphanDocs.map((d) => d.id);
    await db.from("narrative_chunks").delete().in("document_id", orphanIds);
    await db.from("vote_tallies").delete().in("document_id", orphanIds);
    await db.from("policy_decisions").delete().in("document_id", orphanIds);
    await db.from("budget_indicators").delete().in("document_id", orphanIds);
    await db.from("ordinance_provisions").delete().in("document_id", orphanIds);
    const { error: orphanErr } = await db.from("documents").delete().in(
      "id",
      orphanIds,
    );
    if (orphanErr) {
      throw new Error(`Orphan cleanup failed: ${orphanErr.message}`);
    }
  }

  const { data: docRow, error: docErr } = await db
    .from("documents")
    .insert({
      id: uuidv7(),
      content_hash: hash,
      doc_type: docType,
      url: sourceUrl,
      status: "unknown",
      ingested_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (docErr || !docRow) {
    throw new Error(`Document shell insert failed: ${docErr?.message}`);
  }
  const documentId: string = docRow.id;
  console.log(`[pdf-branch] Document shell created: ${documentId}`);

  // 4. Call Docling wrapper — hard-abort before the active row/function deadline.
  let blocks: FlatBlock[];
  let doclingVersion: string;

  const doclingTimeoutMs = boundedTimeoutMs(
    DOCLING_TIMEOUT_MS,
    PDF_POST_DOCLING_BUFFER_MS,
  );
  if (deadlineMs !== undefined && remainingMs() <= PDF_POST_DOCLING_BUFFER_MS) {
    throw new Error("PDF row soft deadline reached before Docling call");
  }
  const doclingController = new AbortController();
  const doclingTimer = setTimeout(
    () => doclingController.abort(),
    doclingTimeoutMs,
  );
  try {
    const docResp = await fetch(`${doclingUrl}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: sourceUrl }),
      signal: doclingController.signal,
    });
    if (!docResp.ok) {
      throw new Error(`Docling wrapper returned HTTP ${docResp.status}`);
    }
    const payload = await docResp.json() as {
      blocks: FlatBlock[];
      block_count: number;
      docling_version: string;
    };
    blocks = payload.blocks;
    doclingVersion = payload.docling_version;
  } catch (e) {
    if (
      e instanceof DOMException && (e as DOMException).name === "AbortError"
    ) {
      throw new Error(
        `Docling call timed out after ${Math.ceil(doclingTimeoutMs / 1000)}s`,
      );
    }
    throw new Error(`Docling call failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(doclingTimer);
  }

  if (!blocks || blocks.length === 0) {
    throw new Error("Docling returned zero blocks — cannot chunk");
  }

  // 5. Tokenizer validation (once per cold start, logged for DEPS.md)
  await validateTokenizer(blocks[0].text);

  // 6. Chunk
  const chunks = await chunkBlocks(blocks, 512, 0.15);
  console.log(
    `[pdf-branch] ${chunks.length} chunks from ${blocks.length} blocks`,
  );

  // 7. Persist raw chunks to document_chunks (task 2-3 handoff)
  if (chunks.length > 0) {
    const chunkRows = chunks.map((c, idx) => ({
      id: uuidv7(),
      document_id: documentId,
      chunk_index: idx,
      text: c.text,
      token_count: c.token_count,
      page_number_start: c.page_number_start,
      page_number_end: c.page_number_end,
      bbox_start: c.bbox_start,
      bbox_end: c.bbox_end,
      reading_order_start: c.reading_order_start,
      reading_order_end: c.reading_order_end,
      overlap_prev: c.overlap_prev,
      overlap_next: c.overlap_next,
    }));

    const { error: chunkErr } = await db.from("document_chunks").insert(
      chunkRows,
    );
    if (chunkErr) throw new Error(`Chunk insert failed: ${chunkErr.message}`);
  }

  // 8. LLM extraction (task 2-4): write structured rows and/or narrative_chunks
  // Note: does NOT set documents.status — finalization is task 2-6's responsibility.
  await extractAndPersist(documentId, docType, chunks, deadlineMs);

  return { documentId, chunks, doclingVersion, skipped: false };
}

// ── Task 2-6: embedding generation for document_chunks ────────────────────────

async function embedDocumentChunks(
  documentId: string,
  embedUrl: string,
): Promise<void> {
  const { data: rows, error: fetchErr } = await db
    .from("document_chunks")
    .select("id, text")
    .eq("document_id", documentId)
    .order("chunk_index");

  if (fetchErr) {
    throw new Error(`Fetching document_chunks failed: ${fetchErr.message}`);
  }
  if (!rows || rows.length === 0) {
    console.log(`[embedder] no document_chunks for document ${documentId}`);
    return;
  }

  const texts = rows.map((r) => r.text as string);
  const embeddings = await generateEmbeddingsHttpBatched(embedUrl, texts);

  // Write embeddings back, one update per chunk — check each write
  for (let i = 0; i < rows.length; i++) {
    const { error: chunkErr } = await db
      .from("document_chunks")
      .update({ embedding: embeddings[i] })
      .eq("id", rows[i].id);
    if (chunkErr) {
      throw new Error(
        `Failed to write embedding for chunk ${
          rows[i].id
        }: ${chunkErr.message}`,
      );
    }
  }

  // DB-side count verification: non-null count must match expected chunk count
  const { count: nonNullCount, error: countErr } = await db
    .from("document_chunks")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .not("embedding", "is", null);
  if (countErr) {
    throw new Error(`Embedding count check failed: ${countErr.message}`);
  }
  if ((nonNullCount ?? 0) !== rows.length) {
    throw new Error(
      `Embedding count mismatch: expected ${rows.length}, got ${
        nonNullCount ?? 0
      } non-null in DB`,
    );
  }
}

// ── Task 2-6: embedding generation for PDF-derived structured tables ──────────

async function embedVoteTallies(
  documentId: string,
  embedUrl: string,
): Promise<void> {
  const { data: rows, error: fetchErr } = await db
    .from("vote_tallies")
    .select("id, motion_text")
    .eq("document_id", documentId);

  if (fetchErr) {
    throw new Error(`Fetching vote_tallies failed: ${fetchErr.message}`);
  }
  if (!rows || rows.length === 0) {
    console.log(`[embedder] no vote_tallies for document ${documentId}`);
    return;
  }

  const texts = rows.map((r) => r.motion_text as string);
  const embeddings = await generateEmbeddingsHttpBatched(embedUrl, texts);

  await persistEmbeddings(db, "vote_tallies", "vote_tally", rows, embeddings);

  const { count, error: countErr } = await db
    .from("vote_tallies")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .is("embedding", null);

  if (countErr) {
    throw new Error(
      `Null-check query failed for vote_tallies: ${countErr.message}`,
    );
  }
  if (count && count > 0) {
    throw new Error(
      `${count} vote_tallies still have null embedding after generation`,
    );
  }
}

async function embedPolicyDecisions(
  documentId: string,
  embedUrl: string,
): Promise<void> {
  const { data: rows, error: fetchErr } = await db
    .from("policy_decisions")
    .select("id, raw_extracted_text")
    .eq("document_id", documentId);

  if (fetchErr) {
    throw new Error(`Fetching policy_decisions failed: ${fetchErr.message}`);
  }
  if (!rows || rows.length === 0) {
    console.log(`[embedder] no policy_decisions for document ${documentId}`);
    return;
  }

  const texts = rows.map((r) => r.raw_extracted_text as string);
  const embeddings = await generateEmbeddingsHttpBatched(embedUrl, texts);

  await persistEmbeddings(
    db,
    "policy_decisions",
    "policy_decision",
    rows,
    embeddings,
  );

  const { count, error: countErr } = await db
    .from("policy_decisions")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .is("embedding", null);

  if (countErr) {
    throw new Error(
      `Null-check query failed for policy_decisions: ${countErr.message}`,
    );
  }
  if (count && count > 0) {
    throw new Error(
      `${count} policy_decisions still have null embedding after generation`,
    );
  }
}

async function embedBudgetIndicators(
  documentId: string,
  embedUrl: string,
): Promise<void> {
  const { data: rows, error: fetchErr } = await db
    .from("budget_indicators")
    .select("id, raw_extracted_text")
    .eq("document_id", documentId);

  if (fetchErr) {
    throw new Error(`Fetching budget_indicators failed: ${fetchErr.message}`);
  }
  if (!rows || rows.length === 0) {
    console.log(`[embedder] no budget_indicators for document ${documentId}`);
    return;
  }

  const texts = rows.map((r) => r.raw_extracted_text as string);
  const embeddings = await generateEmbeddingsHttpBatched(embedUrl, texts);

  await persistEmbeddings(
    db,
    "budget_indicators",
    "budget_indicator",
    rows,
    embeddings,
  );

  const { count, error: countErr } = await db
    .from("budget_indicators")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .is("embedding", null);

  if (countErr) {
    throw new Error(
      `Null-check query failed for budget_indicators: ${countErr.message}`,
    );
  }
  if (count && count > 0) {
    throw new Error(
      `${count} budget_indicators still have null embedding after generation`,
    );
  }
}

async function embedNarrativeChunks(
  documentId: string,
  embedUrl: string,
): Promise<void> {
  const { data: rows, error: fetchErr } = await db
    .from("narrative_chunks")
    .select("id, content")
    .eq("document_id", documentId);

  if (fetchErr) {
    throw new Error(`Fetching narrative_chunks failed: ${fetchErr.message}`);
  }
  if (!rows || rows.length === 0) {
    console.log(`[embedder] no narrative_chunks for document ${documentId}`);
    return;
  }

  const texts = rows.map((r) => r.content as string);
  const embeddings = await generateEmbeddingsHttpBatched(embedUrl, texts);

  await persistEmbeddings(
    db,
    "narrative_chunks",
    "narrative_chunk",
    rows,
    embeddings,
  );

  const { count, error: countErr } = await db
    .from("narrative_chunks")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .is("embedding", null);

  if (countErr) {
    throw new Error(
      `Null-check query failed for narrative_chunks: ${countErr.message}`,
    );
  }
  if (count && count > 0) {
    throw new Error(
      `${count} narrative_chunks still have null embedding after generation`,
    );
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

function duePendingFilter(nowIso: string): string {
  return `next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`;
}

async function claimPendingIngestionById(
  pendingIngestionId: string,
  dueAtIso?: string,
): Promise<ClaimNextResult> {
  let fetchQuery = db
    .from("pending_ingestions")
    .select("id, url, doc_type, attempts, status")
    .eq("id", pendingIngestionId)
    .eq("status", "pending");

  if (dueAtIso) {
    fetchQuery = fetchQuery.or(duePendingFilter(dueAtIso));
  }

  const { data: row, error: fetchErr } = await fetchQuery.maybeSingle();
  if (fetchErr) {
    throw new Error(`DB lookup failed: ${fetchErr.message}`);
  }
  if (!row) {
    return { kind: "claim_lost" };
  }

  const newAttempts = (row.attempts ?? 0) + 1;

  // Skip rows that have hit the absolute retry ceiling before wasting a processing slot.
  if (newAttempts > ABSOLUTE_MAX_ATTEMPTS) {
    const { error: skipErr } = await db
      .from("pending_ingestions")
      .update({
        status: "skipped",
        last_error: "Max attempts exceeded",
        updated_at: new Date().toISOString(),
      })
      .eq("id", pendingIngestionId)
      .eq("status", "pending");
    if (skipErr) {
      throw new Error(`Failed to persist skipped status: ${skipErr.message}`);
    }
    return {
      kind: "skipped",
      id: pendingIngestionId,
      reason: "max_attempts_exceeded",
    };
  }

  // Atomic claim: only the invocation that changes pending -> processing gets
  // the row back and proceeds. A racing invocation sees no returned row.
  let claimQuery = db
    .from("pending_ingestions")
    .update({
      status: "processing",
      attempts: newAttempts,
      next_attempt_at: nextAttemptAt(newAttempts),
      updated_at: new Date().toISOString(),
    })
    .eq("id", pendingIngestionId)
    .eq("status", "pending");

  if (dueAtIso) {
    claimQuery = claimQuery.or(duePendingFilter(dueAtIso));
  }

  const { data: claimed, error: processingErr } = await claimQuery
    .select("id, url, doc_type, attempts, status")
    .maybeSingle();
  if (processingErr) {
    throw new Error(
      `Failed to claim processing slot: ${processingErr.message}`,
    );
  }
  if (!claimed) {
    return { kind: "claim_lost" };
  }

  return {
    kind: "claimed",
    claim: {
      row: claimed as ClaimedPendingIngestion,
      newAttempts,
    },
  };
}

async function claimNextPendingIngestion(): Promise<ClaimNextResult> {
  const now = new Date().toISOString();
  const { data: nextRow, error: pollErr } = await db
    .from("pending_ingestions")
    .select("id")
    .eq("status", "pending")
    .or(duePendingFilter(now))
    .order("detected_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (pollErr) {
    throw new Error(`Poll query failed: ${pollErr.message}`);
  }
  if (!nextRow) {
    return { kind: "idle" };
  }

  return await claimPendingIngestionById(nextRow.id, now);
}

async function processClaimedIngestion(
  row: ClaimedPendingIngestion,
  newAttempts: number,
  softDeadlineMs: number,
  forceFullReingest: boolean,
): Promise<Response> {
  const pendingIngestionId = row.id;

  try {
    const isPdf = (PDF_DOC_TYPES as readonly string[]).includes(row.doc_type);
    const isMunicode = row.doc_type === "municode_api";
    const isEncode = row.doc_type === "encode_zoning";

    // ── Task 2-6: construct AI Session BEFORE any rows are created ──────────
    // Both constructor failure and preflight failure defer without consuming a
    // retry, and no shell/child rows have been written yet so the next run
    // starts clean (no duplicate-insert risk).
    let session: AiSession;
    try {
      // deno-lint-ignore no-explicit-any
      session = new (Supabase as any).ai.Session("gte-small") as AiSession;
    } catch {
      return await deferIngestion(
        pendingIngestionId,
        newAttempts,
        "ai_session_construct_failed",
      );
    }

    const ready = await preflight(session);
    if (!ready) {
      return await deferIngestion(
        pendingIngestionId,
        newAttempts,
        "ai_session_unavailable",
      );
    }

    // ── PDF branch ──────────────────────────────────────────────────────────
    if (isPdf) {
      const { documentId, chunks, doclingVersion, skipped } = await pdfBranch(
        pendingIngestionId,
        row.url,
        row.doc_type,
        softDeadlineMs,
      );

      if (skipped) {
        return success({ status: "skipped", document_id: documentId });
      }

      // ── Task 2-6: embed document_chunks and PDF-derived structured tables ─
      // Runs over HTTP (see generateEmbeddingsHttpBatched), not the local AI
      // Session -- same fix PR #83 applied to ordinance_provisions, for the
      // same reason: session.run() is CPU-bound and was exhausting the Edge
      // Function's CPU-time budget before a single row's embeddings landed,
      // leaving these documents stuck at status='unknown' with narrative_chunks/
      // budget_indicators rows created but never embedded.
      const embedUrl = Deno.env.get("HF_SPACES_DOCLING_URL");
      if (!embedUrl) throw new Error("HF_SPACES_DOCLING_URL not set");

      await embedDocumentChunks(documentId, embedUrl);

      // vote_tallies and policy_decisions are written for bos_minutes/bos_summary;
      // budget_indicators for budget_pdf; narrative_chunks for any PDF type
      // that had chunks without structured extraction.
      const isBosDoc = row.doc_type === "bos_minutes" ||
        row.doc_type === "bos_summary";
      const isBudgetDoc = row.doc_type === "budget_pdf";

      if (isBosDoc) {
        await embedVoteTallies(documentId, embedUrl);
        await embedPolicyDecisions(documentId, embedUrl);
      }
      if (isBudgetDoc) {
        await embedBudgetIndicators(documentId, embedUrl);
      }
      await embedNarrativeChunks(documentId, embedUrl);

      // ── Task 2-6: finalize Document row ──────────────────────────────────
      // Only reached after all embedding functions above have succeeded
      // (none threw), guaranteeing every chunk-bearing row is non-null.
      const { error: docFinalErr } = await db
        .from("documents")
        .update({
          docling_version: doclingVersion,
          status: "current",
          updated_at: new Date().toISOString(),
        })
        .eq("id", documentId);
      if (docFinalErr) {
        throw new Error(`Document finalization failed: ${docFinalErr.message}`);
      }

      // Mark ingestion done
      const { error: ingestDoneErr } = await db
        .from("pending_ingestions")
        .update({ status: "done", updated_at: new Date().toISOString() })
        .eq("id", pendingIngestionId);
      if (ingestDoneErr) {
        throw new Error(
          `Ingestion completion update failed: ${ingestDoneErr.message}`,
        );
      }

      return success({
        status: "done",
        document_id: documentId,
        chunk_count: chunks.length,
      });
    }

    // ── Municode branch ─────────────────────────────────────────────────────
    if (isMunicode) {
      const { documentId, nodeIds, skipped, complete, supplementJobId } =
        await handleMunicode(
          pendingIngestionId,
          softDeadlineMs,
          forceFullReingest,
        );

      if (!complete) {
        return await requeueForResume(pendingIngestionId, newAttempts);
      }

      if (skipped) {
        return success({ status: "skipped", document_id: documentId });
      }

      // ── Task 2-6: embed ordinance_provisions ─────────────────────────────
      // Runs as an HTTP call (see generateEmbeddingsHttp), not the local AI
      // Session, so it isn't subject to the CPU-time budget that throttled
      // this path to 1-3 rows/invocation -- give it the actual time left
      // before this invocation's own SOFT_DEADLINE_MS rather than the small
      // CPU-era default, so a single invocation can drain far more backlog.
      const embedUrl = Deno.env.get("HF_SPACES_DOCLING_URL");
      if (!embedUrl) throw new Error("HF_SPACES_DOCLING_URL not set");

      const ordinanceEmbedResult = await embedOrdinanceProvisionsBatched(
        db,
        embedUrl,
        documentId,
        ORDINANCE_EMBED_FETCH_PAGE_SIZE,
        Math.max(0, softDeadlineMs - Date.now()),
      );
      if (!ordinanceEmbedResult.complete) {
        return await requeueForResume(
          pendingIngestionId,
          newAttempts,
          `[orchestrator] ordinance_provisions embedding soft deadline hit ` +
            `(${ordinanceEmbedResult.processed} row(s) embedded this invocation) — requeued for resume`,
        );
      }

      // ── Task 2-6: finalize Document row ──────────────────────────────────
      const { error: docFinalErr } = await db
        .from("documents")
        .update({ status: "current", updated_at: new Date().toISOString() })
        .eq("id", documentId);
      if (docFinalErr) {
        throw new Error(`Document finalization failed: ${docFinalErr.message}`);
      }

      // ── Task 2-6: check for overlapping PendingCodeChange rows ───────────
      await triggerReconciliationIfNeeded({
        db: db as unknown as ReconciliationTriggerDb,
        nodeIds,
        supplementJobId,
        pendingIngestionId,
      });

      // Mark ingestion done
      const { error: ingestDoneErr } = await db
        .from("pending_ingestions")
        .update({ status: "done", updated_at: new Date().toISOString() })
        .eq("id", pendingIngestionId);
      if (ingestDoneErr) {
        throw new Error(
          `Ingestion completion update failed: ${ingestDoneErr.message}`,
        );
      }

      return success({
        status: "done",
        document_id: documentId,
        provision_count: nodeIds.length,
      });
    }

    // ── EnCode zoning branch ────────────────────────────────────────────────
    if (isEncode) {
      const { documentId, nodeIds, skipped, complete } = await handleEncode(
        pendingIngestionId,
        softDeadlineMs,
        forceFullReingest,
      );

      if (!complete) {
        return await requeueForResume(
          pendingIngestionId,
          newAttempts,
          "[orchestrator] EnCode soft deadline hit — requeued for resume",
        );
      }

      if (skipped) {
        return success({ status: "skipped", document_id: documentId });
      }

      // ── Task 2-6: embed ordinance_provisions ─────────────────────────────
      // Same HTTP embedding path as Municode (PR #83/#89) -- never the local
      // AI Session for this table, for the same CPU-budget reason.
      const embedUrl = Deno.env.get("HF_SPACES_DOCLING_URL");
      if (!embedUrl) throw new Error("HF_SPACES_DOCLING_URL not set");

      const encodeEmbedResult = await embedOrdinanceProvisionsBatched(
        db,
        embedUrl,
        documentId,
        ORDINANCE_EMBED_FETCH_PAGE_SIZE,
        Math.max(0, softDeadlineMs - Date.now()),
      );
      if (!encodeEmbedResult.complete) {
        return await requeueForResume(
          pendingIngestionId,
          newAttempts,
          `[orchestrator] ordinance_provisions embedding soft deadline hit ` +
            `(${encodeEmbedResult.processed} row(s) embedded this invocation) — requeued for resume`,
        );
      }

      // ── Task 2-6: finalize Document row ──────────────────────────────────
      const { error: docFinalErr } = await db
        .from("documents")
        .update({ status: "current", updated_at: new Date().toISOString() })
        .eq("id", documentId);
      if (docFinalErr) {
        throw new Error(`Document finalization failed: ${docFinalErr.message}`);
      }

      // Mark ingestion done
      const { error: ingestDoneErr } = await db
        .from("pending_ingestions")
        .update({ status: "done", updated_at: new Date().toISOString() })
        .eq("id", pendingIngestionId);
      if (ingestDoneErr) {
        throw new Error(
          `Ingestion completion update failed: ${ingestDoneErr.message}`,
        );
      }

      return success({
        status: "done",
        document_id: documentId,
        provision_count: nodeIds.length,
      });
    }

    throw new Error(`Unknown doc_type: ${row.doc_type}`);
  } catch (e) {
    const msg = (e as Error).message ?? "unknown error";
    console.error(`[orchestrator] error on attempt ${newAttempts}:`, msg);

    const isDoclingTimeout = msg.startsWith("Docling call timed out after ");
    const isDoclingHttp500 = msg.includes("Docling wrapper returned HTTP 500");
    // deno-fmt-ignore
    const isSourceFetchTimeout = msg === `Source PDF fetch timed out after ${SOURCE_FETCH_TIMEOUT_MS / 1000}s`;

    // writePendingAlert now throws on failure.  Capture it so we can still
    // complete the status update below before propagating.
    let pendingAlertErr: Error | undefined;
    try {
      await writePendingAlert(pendingIngestionId, msg);
    } catch (ae) {
      pendingAlertErr = ae as Error;
    }

    // PDFs that reliably 500 Docling are too large for the free HF Spaces tier — skip them.
    if (isDoclingHttp500 && newAttempts >= DOCLING_500_MAX_ATTEMPTS) {
      const skipMsg =
        "skipped: Docling HTTP 500 after max attempts (PDF too large for free HF Spaces)";
      const { error: skipErr } = await db
        .from("pending_ingestions")
        .update({
          status: "skipped",
          last_error: skipMsg,
          updated_at: new Date().toISOString(),
        })
        .eq("id", pendingIngestionId);
      if (skipErr) {
        throw new Error(`Failed to persist skipped status: ${skipErr.message}`);
      }
      if (pendingAlertErr) throw pendingAlertErr;
      return success({
        status: "skipped",
        reason: "docling_http500_too_large",
      });
    }

    // Reset to pending for retry.
    // Timeout: override next_attempt_at to 15 min (the processing-mark value may be
    // longer than needed for a transient wall-clock hang).
    const nextRetryAt = (isDoclingTimeout || isSourceFetchTimeout)
      ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
      : nextAttemptAt(newAttempts);

    const { error: resetErr } = await db
      .from("pending_ingestions")
      .update({
        status: "pending",
        last_error: msg,
        next_attempt_at: nextRetryAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", pendingIngestionId);
    if (resetErr) {
      throw new Error(
        `Failed to reset ingestion to 'pending' for retry: ${resetErr.message}`,
      );
    }
    if (pendingAlertErr) throw pendingAlertErr;

    // Return 200 for expected timeouts so pg_cron logs stay clean.
    if (isDoclingTimeout) {
      return success({ status: "deferred", reason: "docling_timeout" });
    }
    if (isSourceFetchTimeout) {
      return success({ status: "deferred", reason: "source_fetch_timeout" });
    }
    return error(
      "INGESTION_FAILED",
      "Ingestion attempt failed — will retry",
      500,
    );
  }
}

async function summarizeProcessResponse(
  id: string,
  response: Response,
): Promise<
  { id: string; ok: boolean; status: number; data?: unknown; error?: unknown }
> {
  let body: { ok?: boolean; data?: unknown; error?: unknown } = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  return {
    id,
    ok: response.ok && body.ok !== false,
    status: response.status,
    data: body.data,
    error: body.error,
  };
}

Deno.serve(async (req: Request) => {
  const FUNCTION_START_MS = Date.now();
  const SOFT_DEADLINE_MS = FUNCTION_START_MS + 120_000; // 120 s — well under ~150 s hard kill
  const CLAIM_DEADLINE_MS = FUNCTION_START_MS + POLL_CLAIM_WINDOW_MS;

  if (req.method !== "POST") {
    return error("NOT_FOUND", "Method not allowed", 405);
  }

  let body: {
    pending_ingestion_id?: string;
    force_full_reingest?: boolean;
    municode_historical_backfill?: boolean;
  } = {};
  try {
    const text = await req.text();
    if (text.trim()) {
      body = JSON.parse(text);
    }
  } catch {
    return error("INGESTION_FAILED", "Invalid JSON body", 400);
  }

  // force_full_reingest bypasses the Municode branch's top-level content_hash
  // skip for a one-off admin backfill/verification run — never set by the
  // cron poll path, so normal periodic-recheck dedup is unaffected.
  let forceFullReingest = false;
  if (body?.force_full_reingest === true) {
    const adminSecret = Deno.env.get("ADMIN_SECRET");
    if (!adminSecret || requestSecret(req) !== adminSecret) {
      return error(
        "UNAUTHORIZED",
        "force_full_reingest requires a valid admin secret",
        401,
      );
    }
    forceFullReingest = true;
  }

  if (body?.municode_historical_backfill === true) {
    const adminSecret = Deno.env.get("ADMIN_SECRET");
    if (!adminSecret || requestSecret(req) !== adminSecret) {
      return error(
        "UNAUTHORIZED",
        "municode_historical_backfill requires a valid admin secret",
        401,
      );
    }
    try {
      const result = await handleMunicodeHistoricalBackfill(SOFT_DEADLINE_MS);
      return success({
        status: result.complete ? "done" : "in_progress",
        ...result,
      });
    } catch (e) {
      console.error(
        "[orchestrator] municode historical backfill failed:",
        (e as Error).message,
      );
      return error(
        "INGESTION_FAILED",
        "Municode historical backfill failed",
        500,
      );
    }
  }

  if (body?.pending_ingestion_id) {
    let claim: ClaimNextResult;
    try {
      claim = await claimPendingIngestionById(body.pending_ingestion_id);
    } catch (e) {
      console.error(
        "[orchestrator] explicit claim failed:",
        (e as Error).message,
      );
      return error("INGESTION_FAILED", "Failed to claim processing slot", 500);
    }
    if (claim.kind === "claim_lost" || claim.kind === "idle") {
      return success({ skipped: true, reason: "not_pending" });
    }
    if (claim.kind === "skipped") {
      return success({ status: "skipped", reason: claim.reason });
    }

    return await processClaimedIngestion(
      claim.claim.row,
      claim.claim.newAttempts,
      SOFT_DEADLINE_MS,
      forceFullReingest,
    );
  }

  try {
    const historicalEmbeddingRetry =
      await handleMunicodeHistoricalEmbeddingRetry(SOFT_DEADLINE_MS);
    // Only bail out early if the retry ran out of deadline budget — if it
    // drained the due backlog (even having done work) within budget, fall
    // through to the regular pending_ingestions loop below using whatever
    // deadline remains (CLAIM_DEADLINE_MS/SOFT_DEADLINE_MS are absolute
    // timestamps anchored to FUNCTION_START_MS, so this happens for free).
    // Otherwise a single due historical-embedding-retry row would starve
    // regular ingestion for the entire cron tick.
    if (!historicalEmbeddingRetry.complete) {
      return success({
        status: "in_progress",
        historical_embedding_retry: historicalEmbeddingRetry,
      });
    }
  } catch (e) {
    // This backlog-drain step is ancillary to the regular pending_ingestions
    // loop below, which is the higher-priority path (real document ingestion).
    // A failure here -- e.g. a schema this step depends on not yet matching
    // what this deploy expects -- must not take down the whole invocation and
    // skip regular ingestion for the cron tick. Log and fall through, the
    // same "don't let historical-retry work starve regular ingestion"
    // principle the !complete guard above already applies on the success path.
    console.error(
      "[orchestrator] historical embedding retry failed — continuing to regular ingestion:",
      (e as Error).message,
    );
  }

  let loop;
  try {
    loop = await runPendingIngestionLoop({
      deadlineMs: CLAIM_DEADLINE_MS,
      claimNext: claimNextPendingIngestion,
      processClaim: async (claim: PendingIngestionClaim) => {
        const rowSoftDeadlineMs = (PDF_DOC_TYPES as readonly string[]).includes(
            claim.row.doc_type,
          )
          ? Math.min(
            SOFT_DEADLINE_MS,
            Date.now() + POLL_PDF_ROW_BUDGET_MS,
          )
          : SOFT_DEADLINE_MS;
        const response = await processClaimedIngestion(
          claim.row,
          claim.newAttempts,
          rowSoftDeadlineMs,
          forceFullReingest,
        );
        return await summarizeProcessResponse(claim.row.id, response);
      },
      onRowError: (id, rowErr) => {
        console.error(
          `[orchestrator] unhandled row error after claim ${id}:`,
          rowErr.message,
        );
      },
    });
  } catch (e) {
    console.error("[orchestrator] poll loop failed:", (e as Error).message);
    return error("INGESTION_FAILED", "Poll query failed", 500);
  }

  return success({
    status: loop.status,
    claimed: loop.claimed,
    processed: loop.processed,
    failed: loop.failed,
    skipped: loop.skipped,
    claim_lost: loop.claimLost,
    deadline_ms: CLAIM_DEADLINE_MS,
    rows: loop.rows,
  });
});
