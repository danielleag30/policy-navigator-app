import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import db from "../_shared/db-client.ts";
import { contentHash } from "../_shared/hash.ts";
import { error, success } from "../_shared/response.ts";

const PDF_DOC_TYPES = new Set(["bos_minutes", "bos_summary", "budget_pdf"]);

function nextAttemptAt(attempts: number): string {
  const now = Date.now();
  const offsets: Record<number, number> = {
    1: 1 * 60 * 1000,
    2: 5 * 60 * 1000,
  };
  const ms = attempts <= 2 ? offsets[attempts] : 30 * 60 * 1000;
  return new Date(now + ms).toISOString();
}

Deno.serve(async (req: Request): Promise<Response> => {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return error("INGESTION_FAILED", "Invalid request body");
  }

  const pendingIngestionId = body.pending_ingestion_id as string | undefined;
  if (!pendingIngestionId) {
    return error("INGESTION_FAILED", "Missing required field: pending_ingestion_id");
  }

  // Fetch the pending ingestion row with explicit status = 'pending' filter
  const { data: row, error: fetchErr } = await db
    .from("pending_ingestions")
    .select("id, status, attempts, doc_type, source_url")
    .eq("id", pendingIngestionId)
    .eq("status", "pending")
    .single();

  if (fetchErr || !row) {
    return error("NOT_FOUND", "Ingestion not found or not pending", 404);
  }

  const newAttempts = (row.attempts as number) + 1;
  const nextAt = nextAttemptAt(newAttempts);

  // Mark as processing
  const { error: updateErr } = await db
    .from("pending_ingestions")
    .update({
      status: "processing",
      attempts: newAttempts,
      next_attempt_at: nextAt,
    })
    .eq("id", row.id);

  if (updateErr) {
    return error("INGESTION_FAILED", "Failed to claim ingestion row");
  }

  try {
    const docType = row.doc_type as string;

    if (PDF_DOC_TYPES.has(docType)) {
      return await handlePdf(row.id as string, docType, row.source_url as string, newAttempts);
    } else if (docType === "municode_api") {
      return await handleMunicode();
    } else {
      return error("INGESTION_FAILED", `Unknown doc_type: ${docType}`);
    }
  } catch (err: unknown) {
    // Log internally, never expose stack trace
    console.error("Orchestrator error:", err instanceof Error ? err.message : String(err));

    const safeMessage = err instanceof Error ? err.message : "Internal ingestion error";

    // Write a pending alert
    await db.from("pending_alerts").insert({
      pending_ingestion_id: row.id,
      alert_type: "ingestion_error",
      message: safeMessage,
    });

    // After 3+ failed attempts, mark as failed
    if (newAttempts >= 3) {
      await db
        .from("pending_ingestions")
        .update({ status: "failed" })
        .eq("id", row.id);
    } else {
      // Reset to pending so the scheduler can retry on next_attempt_at
      await db
        .from("pending_ingestions")
        .update({ status: "pending" })
        .eq("id", row.id);
    }

    return error("INGESTION_FAILED", "Ingestion failed; alert recorded");
  }
});

async function handlePdf(
  pendingIngestionId: string,
  docType: string,
  sourceUrl: string,
  attempts: number,
): Promise<Response> {
  // Fetch the PDF bytes
  const fetchResp = await fetch(sourceUrl);
  if (!fetchResp.ok) {
    throw new Error(`Failed to fetch source document: HTTP ${fetchResp.status}`);
  }

  // Compute content_hash BEFORE creating any Document row
  const buffer = await fetchResp.arrayBuffer();
  const text = new TextDecoder().decode(buffer);
  const hash = await contentHash(text);

  // Check for existing document with same hash and status = 'current'
  const { data: existing } = await db
    .from("documents")
    .select("id")
    .eq("content_hash", hash)
    .eq("status", "current")
    .maybeSingle();

  if (existing) {
    await db
      .from("pending_ingestions")
      .update({ status: "skipped" })
      .eq("id", pendingIngestionId);
    return success({ status: "skipped" });
  }

  // Create document shell row
  const { data: newDoc, error: insertErr } = await db
    .from("documents")
    .insert({
      content_hash: hash,
      doc_type: docType,
      status: "unknown",
      ingested_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertErr || !newDoc) {
    throw new Error("Failed to create document shell row");
  }

  const documentId = newDoc.id as string;

  // PDF sub-handler stub (real handler: task 2-4)
  console.log("PDF stub: document_id =", documentId, "doc_type =", docType);

  await db
    .from("pending_ingestions")
    .update({ status: "completed" })
    .eq("id", pendingIngestionId);

  return success({ status: "completed", document_id: documentId });
}

async function handleMunicode(): Promise<Response> {
  // Municode stub (real handler: task 2-5)
  // Does NOT compute content_hash or create a Document shell row
  console.log("municode stub");
  return success({ status: "routed", handler: "municode" });
}
