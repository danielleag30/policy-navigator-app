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

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { error, success } from "../_shared/response.ts";
import { contentHash } from "../_shared/hash.ts";
import {
  chunkBlocks,
  validateTokenizer,
  type Chunk,
  type FlatBlock,
} from "../_shared/chunker.ts";
import { extractAndPersist } from "../_shared/extractor.ts";
import {
  preflight,
  generateEmbeddings,
  type AiSession,
} from "../_shared/embedder.ts";
import { handleMunicode } from "./municode.ts";

// Supabase.ai.Session is injected by the Edge Function runtime.
// Declare here so TypeScript resolves it; actual availability is checked at runtime.
declare const Supabase: {
  ai: { Session: new (model: string) => AiSession };
};

// ── Constants ─────────────────────────────────────────────────────────────────

const PDF_DOC_TYPES = ["bos_minutes", "bos_summary", "budget_pdf"] as const;

/** Exponential backoff schedule (minutes) indexed by attempt number (1-based). */
const BACKOFF_MINUTES: Record<number, number> = { 1: 1, 2: 5, 3: 30 };

const MAX_ATTEMPTS = 3;

/** When Supabase AI Session is unavailable, defer for this many minutes. */
const AI_SESSION_DEFER_MINUTES = 15;

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
    throw new Error(`Defer-without-retry DB update failed (${reason}): ${deferErr.message}`);
  }
  await writePendingAlert(
    pendingIngestionId,
    `AI Session unavailable (${reason}) — deferred without consuming retry`,
  );
  console.warn(`[orchestrator] deferred ingestion: ${reason}`);
  return success({ status: "deferred", reason: "ai_session_unavailable" });
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
): Promise<PdfBranchResult> {
  const doclingUrl = Deno.env.get("HF_SPACES_DOCLING_URL");
  if (!doclingUrl) throw new Error("HF_SPACES_DOCLING_URL not set");

  // 1. Fetch source PDF bytes for content_hash
  let pdfBytes: Uint8Array;
  try {
    const resp = await fetch(sourceUrl, { redirect: "follow" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching source PDF`);
    pdfBytes = new Uint8Array(await resp.arrayBuffer());
  } catch (e) {
    throw new Error(`Source fetch failed: ${(e as Error).message}`);
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
      throw new Error(`Failed to mark ingestion as skipped: ${skipErr.message}`);
    }
    console.log(`[pdf-branch] duplicate content_hash ${hash} — skipped`);
    return { documentId: existing.id, chunks: [], doclingVersion: "", skipped: true };
  }

  // 3. Remove any orphaned shell left by a prior failed attempt, then insert fresh.
  // Without this, a retry hits the unique constraint on documents.url when an
  // earlier run created a status='unknown' row that the content_hash dedup above
  // won't find (it only matches status='current').
  const { error: orphanErr } = await db
    .from("documents")
    .delete()
    .eq("url", sourceUrl)
    .eq("status", "unknown");
  if (orphanErr) throw new Error(`Orphan cleanup failed: ${orphanErr.message}`);

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

  // 4. Call Docling wrapper
  let blocks: FlatBlock[];
  let doclingVersion: string;

  try {
    const docResp = await fetch(`${doclingUrl}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: sourceUrl }),
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
    throw new Error(`Docling call failed: ${(e as Error).message}`);
  }

  if (!blocks || blocks.length === 0) {
    throw new Error("Docling returned zero blocks — cannot chunk");
  }

  // 5. Tokenizer validation (once per cold start, logged for DEPS.md)
  await validateTokenizer(blocks[0].text);

  // 6. Chunk
  const chunks = await chunkBlocks(blocks, 512, 0.15);
  console.log(`[pdf-branch] ${chunks.length} chunks from ${blocks.length} blocks`);

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

    const { error: chunkErr } = await db.from("document_chunks").insert(chunkRows);
    if (chunkErr) throw new Error(`Chunk insert failed: ${chunkErr.message}`);
  }

  // 8. LLM extraction (task 2-4): write structured rows and/or narrative_chunks
  // Note: does NOT set documents.status — finalization is task 2-6's responsibility.
  await extractAndPersist(documentId, docType, chunks);

  return { documentId, chunks, doclingVersion, skipped: false };
}

// ── Task 2-6: embedding generation for document_chunks ────────────────────────

async function embedDocumentChunks(
  documentId: string,
  session: AiSession,
): Promise<void> {
  const { data: rows, error: fetchErr } = await db
    .from("document_chunks")
    .select("id, text")
    .eq("document_id", documentId)
    .order("chunk_index");

  if (fetchErr) throw new Error(`Fetching document_chunks failed: ${fetchErr.message}`);
  if (!rows || rows.length === 0) {
    console.log(`[embedder] no document_chunks for document ${documentId}`);
    return;
  }

  const texts = rows.map((r) => r.text as string);
  const embeddings = await generateEmbeddings(session, texts);

  // Write embeddings back, one update per chunk — check each write
  for (let i = 0; i < rows.length; i++) {
    const { error: chunkErr } = await db
      .from("document_chunks")
      .update({ embedding: embeddings[i] })
      .eq("id", rows[i].id);
    if (chunkErr) {
      throw new Error(`Failed to write embedding for chunk ${rows[i].id}: ${chunkErr.message}`);
    }
  }

  // DB-side count verification: non-null count must match expected chunk count
  const { count: nonNullCount, error: countErr } = await db
    .from("document_chunks")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .not("embedding", "is", null);
  if (countErr) throw new Error(`Embedding count check failed: ${countErr.message}`);
  if ((nonNullCount ?? 0) !== rows.length) {
    throw new Error(
      `Embedding count mismatch: expected ${rows.length}, got ${nonNullCount ?? 0} non-null in DB`,
    );
  }
}

// ── Task 2-6: embedding generation for PDF-derived structured tables ──────────

async function embedVoteTallies(
  documentId: string,
  session: AiSession,
): Promise<void> {
  const { data: rows, error: fetchErr } = await db
    .from("vote_tallies")
    .select("id, motion_text")
    .eq("document_id", documentId);

  if (fetchErr) throw new Error(`Fetching vote_tallies failed: ${fetchErr.message}`);
  if (!rows || rows.length === 0) {
    console.log(`[embedder] no vote_tallies for document ${documentId}`);
    return;
  }

  const texts = rows.map((r) => r.motion_text as string);
  const embeddings = await generateEmbeddings(session, texts);

  await Promise.all(
    rows.map((row, i) => {
      const emb = embeddings[i];
      if (emb === null) {
        console.error(`[embedder] null embedding for vote_tally ${row.id}`);
        return Promise.resolve();
      }
      return db
        .from("vote_tallies")
        .update({ embedding: emb, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .then(({ error: updErr }) => {
          if (updErr) {
            throw new Error(`Failed to persist embedding for vote_tally ${row.id}: ${updErr.message}`);
          }
        });
    }),
  );

  const { count, error: countErr } = await db
    .from("vote_tallies")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .is("embedding", null);

  if (countErr) {
    throw new Error(`Null-check query failed for vote_tallies: ${countErr.message}`);
  }
  if (count && count > 0) {
    throw new Error(`${count} vote_tallies still have null embedding after generation`);
  }
}

async function embedPolicyDecisions(
  documentId: string,
  session: AiSession,
): Promise<void> {
  const { data: rows, error: fetchErr } = await db
    .from("policy_decisions")
    .select("id, raw_extracted_text")
    .eq("document_id", documentId);

  if (fetchErr) throw new Error(`Fetching policy_decisions failed: ${fetchErr.message}`);
  if (!rows || rows.length === 0) {
    console.log(`[embedder] no policy_decisions for document ${documentId}`);
    return;
  }

  const texts = rows.map((r) => r.raw_extracted_text as string);
  const embeddings = await generateEmbeddings(session, texts);

  await Promise.all(
    rows.map((row, i) => {
      const emb = embeddings[i];
      if (emb === null) {
        console.error(`[embedder] null embedding for policy_decision ${row.id}`);
        return Promise.resolve();
      }
      return db
        .from("policy_decisions")
        .update({ embedding: emb, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .then(({ error: updErr }) => {
          if (updErr) {
            throw new Error(`Failed to persist embedding for policy_decision ${row.id}: ${updErr.message}`);
          }
        });
    }),
  );

  const { count, error: countErr } = await db
    .from("policy_decisions")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .is("embedding", null);

  if (countErr) {
    throw new Error(`Null-check query failed for policy_decisions: ${countErr.message}`);
  }
  if (count && count > 0) {
    throw new Error(`${count} policy_decisions still have null embedding after generation`);
  }
}

async function embedBudgetIndicators(
  documentId: string,
  session: AiSession,
): Promise<void> {
  const { data: rows, error: fetchErr } = await db
    .from("budget_indicators")
    .select("id, raw_extracted_text")
    .eq("document_id", documentId);

  if (fetchErr) throw new Error(`Fetching budget_indicators failed: ${fetchErr.message}`);
  if (!rows || rows.length === 0) {
    console.log(`[embedder] no budget_indicators for document ${documentId}`);
    return;
  }

  const texts = rows.map((r) => r.raw_extracted_text as string);
  const embeddings = await generateEmbeddings(session, texts);

  await Promise.all(
    rows.map((row, i) => {
      const emb = embeddings[i];
      if (emb === null) {
        console.error(`[embedder] null embedding for budget_indicator ${row.id}`);
        return Promise.resolve();
      }
      return db
        .from("budget_indicators")
        .update({ embedding: emb, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .then(({ error: updErr }) => {
          if (updErr) {
            throw new Error(`Failed to persist embedding for budget_indicator ${row.id}: ${updErr.message}`);
          }
        });
    }),
  );

  const { count, error: countErr } = await db
    .from("budget_indicators")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .is("embedding", null);

  if (countErr) {
    throw new Error(`Null-check query failed for budget_indicators: ${countErr.message}`);
  }
  if (count && count > 0) {
    throw new Error(`${count} budget_indicators still have null embedding after generation`);
  }
}

async function embedNarrativeChunks(
  documentId: string,
  session: AiSession,
): Promise<void> {
  const { data: rows, error: fetchErr } = await db
    .from("narrative_chunks")
    .select("id, content")
    .eq("document_id", documentId);

  if (fetchErr) throw new Error(`Fetching narrative_chunks failed: ${fetchErr.message}`);
  if (!rows || rows.length === 0) {
    console.log(`[embedder] no narrative_chunks for document ${documentId}`);
    return;
  }

  const texts = rows.map((r) => r.content as string);
  const embeddings = await generateEmbeddings(session, texts);

  await Promise.all(
    rows.map((row, i) => {
      const emb = embeddings[i];
      if (emb === null) {
        console.error(`[embedder] null embedding for narrative_chunk ${row.id}`);
        return Promise.resolve();
      }
      return db
        .from("narrative_chunks")
        .update({ embedding: emb, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .then(({ error: updErr }) => {
          if (updErr) {
            throw new Error(`Failed to persist embedding for narrative_chunk ${row.id}: ${updErr.message}`);
          }
        });
    }),
  );

  const { count, error: countErr } = await db
    .from("narrative_chunks")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .is("embedding", null);

  if (countErr) {
    throw new Error(`Null-check query failed for narrative_chunks: ${countErr.message}`);
  }
  if (count && count > 0) {
    throw new Error(`${count} narrative_chunks still have null embedding after generation`);
  }
}

// ── Task 2-6: embedding generation for ordinance_provisions ───────────────────

async function embedOrdinanceProvisions(
  documentId: string,
  session: AiSession,
): Promise<void> {
  const { data: rows, error: fetchErr } = await db
    .from("ordinance_provisions")
    .select("id, content")
    .eq("document_id", documentId);

  if (fetchErr) {
    throw new Error(`Fetching ordinance_provisions failed: ${fetchErr.message}`);
  }
  if (!rows || rows.length === 0) {
    console.log(`[embedder] no ordinance_provisions for document ${documentId}`);
    return;
  }

  const texts = rows.map((r) => r.content as string);
  const embeddings = await generateEmbeddings(session, texts);

  await Promise.all(
    rows.map((row, i) => {
      const emb = embeddings[i];
      if (emb === null) {
        console.error(`[embedder] null embedding for provision ${row.id}`);
        return Promise.resolve();
      }
      return db
        .from("ordinance_provisions")
        .update({ embedding: emb, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .then(({ error: updErr }) => {
          if (updErr) {
            throw new Error(`Failed to persist embedding for provision ${row.id}: ${updErr.message}`);
          }
        });
    }),
  );

  // Verify no nulls remain
  const { count, error: countErr } = await db
    .from("ordinance_provisions")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .is("embedding", null);

  if (countErr) {
    throw new Error(`Null-check query failed for ordinance_provisions: ${countErr.message}`);
  }
  if (count && count > 0) {
    throw new Error(
      `${count} ordinance_provisions still have null embedding after generation`,
    );
  }
}

// ── Task 2-6: Municode reconciliation trigger ─────────────────────────────────

async function triggerReconciliationIfNeeded(
  documentId: string,
  nodeIds: string[],
): Promise<void> {
  if (nodeIds.length === 0) return;

  const { data: pending, error: pendingErr } = await db
    .from("pending_code_changes")
    .select("id")
    .in("municode_node_id", nodeIds)
    .eq("codification_status", "pending");

  if (pendingErr) {
    console.error("[orchestrator] PendingCodeChange lookup failed:", pendingErr.message);
    return;
  }

  if (!pending || pending.length === 0) return;

  console.log(
    `[orchestrator] ${pending.length} overlapping PendingCodeChange(s) found — triggering reconciliation`,
  );

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("[orchestrator] missing env vars for reconciliation invoke");
    return;
  }

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/reconcile-ordinances`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ document_id: documentId }),
    });
    if (!resp.ok) {
      console.warn(
        `[orchestrator] reconcile-ordinances returned HTTP ${resp.status}`,
      );
    } else {
      console.log("[orchestrator] reconciliation triggered successfully");
    }
  } catch (e) {
    // Reconciliation function may not yet be deployed — log and continue.
    console.warn(
      "[orchestrator] reconcile-ordinances invoke failed (may not be deployed):",
      (e as Error).message,
    );
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return error("NOT_FOUND", "Method not allowed", 405);
  }

  let pendingIngestionId: string;
  let body: { pending_ingestion_id?: string } = {};
  try {
    const text = await req.text();
    if (text.trim()) {
      body = JSON.parse(text);
    }
  } catch {
    return error("INGESTION_FAILED", "Invalid JSON body", 400);
  }
  if (body?.pending_ingestion_id) {
    pendingIngestionId = body.pending_ingestion_id;
  } else {
    // Poll mode: cron invokes with empty body — find the next eligible row.
    const now = new Date().toISOString();
    const { data: nextRow, error: pollErr } = await db
      .from("pending_ingestions")
      .select("id")
      .eq("status", "pending")
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
      .order("detected_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (pollErr) return error("INGESTION_FAILED", "Poll query failed", 500);
    if (!nextRow) return success({ status: "idle", reason: "no_pending_rows" });
    pendingIngestionId = nextRow.id;
  }

  // Fetch PendingIngestion row (status = 'pending' only)
  const { data: row, error: fetchErr } = await db
    .from("pending_ingestions")
    .select("id, url, doc_type, attempts, status")
    .eq("id", pendingIngestionId)
    .eq("status", "pending")
    .maybeSingle();

  if (fetchErr) {
    return error("INGESTION_FAILED", "DB lookup failed", 500);
  }
  if (!row) {
    return success({ skipped: true, reason: "not_pending" });
  }

  const newAttempts = (row.attempts ?? 0) + 1;

  // Mark processing — fail loudly so later logic does not proceed on a write that never persisted.
  // If this fails the row stays 'pending' and pg_cron will pick it up again with no attempt consumed.
  const { error: processingErr } = await db
    .from("pending_ingestions")
    .update({
      status: "processing",
      attempts: newAttempts,
      next_attempt_at: nextAttemptAt(newAttempts),
      updated_at: new Date().toISOString(),
    })
    .eq("id", pendingIngestionId);
  if (processingErr) {
    return error("INGESTION_FAILED", "Failed to claim processing slot", 500);
  }

  try {
    const isPdf = (PDF_DOC_TYPES as readonly string[]).includes(row.doc_type);
    const isMunicode = row.doc_type === "municode_api";

    // ── Task 2-6: construct AI Session BEFORE any rows are created ──────────
    // Both constructor failure and preflight failure defer without consuming a
    // retry, and no shell/child rows have been written yet so the next run
    // starts clean (no duplicate-insert risk).
    let session: AiSession;
    try {
      // deno-lint-ignore no-explicit-any
      session = new (Supabase as any).ai.Session("gte-small") as AiSession;
    } catch {
      return await deferIngestion(pendingIngestionId, newAttempts, "ai_session_construct_failed");
    }

    const ready = await preflight(session);
    if (!ready) {
      return await deferIngestion(pendingIngestionId, newAttempts, "ai_session_unavailable");
    }

    // ── PDF branch ──────────────────────────────────────────────────────────
    if (isPdf) {
      const { documentId, chunks, doclingVersion, skipped } = await pdfBranch(
        pendingIngestionId,
        row.url,
        row.doc_type,
      );

      if (skipped) {
        return success({ status: "skipped", document_id: documentId });
      }

      // ── Task 2-6: embed document_chunks ──────────────────────────────────
      await embedDocumentChunks(documentId, session);

      // ── Task 2-6: embed all PDF-derived structured tables ─────────────────
      // vote_tallies and policy_decisions are written for bos_minutes/bos_summary;
      // budget_indicators for budget_pdf; narrative_chunks for any PDF type
      // that had chunks without structured extraction.
      const isBosDoc = row.doc_type === "bos_minutes" || row.doc_type === "bos_summary";
      const isBudgetDoc = row.doc_type === "budget_pdf";

      if (isBosDoc) {
        await embedVoteTallies(documentId, session);
        await embedPolicyDecisions(documentId, session);
      }
      if (isBudgetDoc) {
        await embedBudgetIndicators(documentId, session);
      }
      await embedNarrativeChunks(documentId, session);

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
        throw new Error(`Ingestion completion update failed: ${ingestDoneErr.message}`);
      }

      return success({
        status: "done",
        document_id: documentId,
        chunk_count: chunks.length,
      });
    }

    // ── Municode branch ─────────────────────────────────────────────────────
    if (isMunicode) {
      const { documentId, nodeIds, skipped } = await handleMunicode(
        pendingIngestionId,
      );

      if (skipped) {
        return success({ status: "skipped", document_id: documentId });
      }

      // ── Task 2-6: embed ordinance_provisions ─────────────────────────────
      await embedOrdinanceProvisions(documentId, session);

      // ── Task 2-6: finalize Document row ──────────────────────────────────
      const { error: docFinalErr } = await db
        .from("documents")
        .update({ status: "current", updated_at: new Date().toISOString() })
        .eq("id", documentId);
      if (docFinalErr) {
        throw new Error(`Document finalization failed: ${docFinalErr.message}`);
      }

      // ── Task 2-6: check for overlapping PendingCodeChange rows ───────────
      await triggerReconciliationIfNeeded(documentId, nodeIds);

      // Mark ingestion done
      const { error: ingestDoneErr } = await db
        .from("pending_ingestions")
        .update({ status: "done", updated_at: new Date().toISOString() })
        .eq("id", pendingIngestionId);
      if (ingestDoneErr) {
        throw new Error(`Ingestion completion update failed: ${ingestDoneErr.message}`);
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

    // writePendingAlert now throws on failure.  Capture it so we can still
    // complete the status update below before propagating.
    let pendingAlertErr: Error | undefined;
    try {
      await writePendingAlert(pendingIngestionId, msg);
    } catch (ae) {
      pendingAlertErr = ae as Error;
    }

    if (newAttempts >= MAX_ATTEMPTS) {
      const { error: failedErr } = await db
        .from("pending_ingestions")
        .update({ status: "failed", last_error: msg, updated_at: new Date().toISOString() })
        .eq("id", pendingIngestionId);
      if (failedErr) {
        throw new Error(`Failed to persist 'failed' status after max attempts: ${failedErr.message}`);
      }
      // Status is persisted; now surface the alert write failure loudly.
      if (pendingAlertErr) throw pendingAlertErr;
      return error("INGESTION_FAILED", "Max attempts reached", 500);
    }

    // Reset to pending for next pg_cron retry
    const { error: resetErr } = await db
      .from("pending_ingestions")
      .update({ status: "pending", last_error: msg, updated_at: new Date().toISOString() })
      .eq("id", pendingIngestionId);
    if (resetErr) {
      throw new Error(`Failed to reset ingestion to 'pending' for retry: ${resetErr.message}`);
    }
    // Status is persisted; now surface the alert write failure loudly.
    if (pendingAlertErr) throw pendingAlertErr;

    return error("INGESTION_FAILED", "Ingestion attempt failed — will retry", 500);
  }
});
