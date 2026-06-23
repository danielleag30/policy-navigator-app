/**
 * reconciliation — code reconciliation Edge Function.
 *
 * Triggered by change-detection (POST with supplement_job_id) or manually via HTTP POST.
 * Compares pending_code_changes against current ordinance_provisions using Ollama and
 * writes code_reconciliation_logs rows.
 */

// deno-lint-ignore no-unversioned-import
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { ollamaChat } from "../_shared/ollama-client.ts";
import { error, success } from "../_shared/response.ts";
import {
  buildReconciliationMessages,
  parseLlmResult,
  type OllamaReconciliationResult,
  type ReconciliationResult,
} from "./_helpers.ts";

interface PendingCodeChange {
  id: string;
  municode_node_id: string;
  proposed_text: string | null;
  on_spot_edits: string | null;
  document_id: string;
}

interface OrdinanceProvision {
  id: string;
  municode_node_id: string;
  content: string;
  document_id: string;
}

const UNIQUE_VIOLATION_CODE = "23505";

async function callOllamaForReconciliation(
  pendingChange: PendingCodeChange,
  provision: OrdinanceProvision,
): Promise<OllamaReconciliationResult> {
  const messages = buildReconciliationMessages(pendingChange, provision);
  const llmResult = await ollamaChat(messages, 0.0);

  if (llmResult.exhausted) {
    throw new Error("Ollama exhausted: could not complete reconciliation comparison");
  }

  return parseLlmResult(llmResult.content);
}

async function writePendingAlert(details: Record<string, unknown>): Promise<void> {
  const { error: alertErr } = await db.from("pending_alerts").insert({
    id: uuidv7(),
    alert_type: "ingestion_failure",
    details,
    triggered_at: new Date().toISOString(),
  });

  if (alertErr) {
    throw new Error(`PendingAlert insert failed: ${alertErr.message}`);
  }
}

interface ReconcilePairOutcome {
  skipped: boolean;
  result?: ReconciliationResult;
}

async function reconcilePair(
  pendingChange: PendingCodeChange,
  provision: OrdinanceProvision,
  supplementJobId: string,
): Promise<ReconcilePairOutcome> {
  const llmResult = await callOllamaForReconciliation(pendingChange, provision);

  const requiresHumanReview =
    llmResult.result === "mismatch" || llmResult.result === "partial_match";

  const { error: logErr } = await db.from("code_reconciliation_logs").insert({
    id: uuidv7(),
    municode_node_id: pendingChange.municode_node_id,
    pending_code_change_id: pendingChange.id,
    ordinance_provision_id: provision.id,
    document_id: pendingChange.document_id,
    reconciliation_result: llmResult.result,
    llm_comparison_notes: llmResult.notes || null,
    requires_human_review: requiresHumanReview,
    supplement_job_id: supplementJobId,
  });

  if (logErr) {
    // Concurrent duplicate: skip gracefully without crashing
    if (logErr.code === UNIQUE_VIOLATION_CODE) {
      console.warn(
        `[reconciliation] unique constraint hit for pair (${pendingChange.id}, ${provision.id}) — skipping`,
      );
      return { skipped: true };
    }
    throw new Error(`ReconciliationLog insert failed: ${logErr.message}`);
  }

  if (llmResult.result === "matched") {
    const { error: updateErr } = await db
      .from("pending_code_changes")
      .update({
        codification_status: "codified",
        codified_at: new Date().toISOString(),
      })
      .eq("id", pendingChange.id);

    if (updateErr) {
      throw new Error(`PendingCodeChange update failed: ${updateErr.message}`);
    }
  } else if (llmResult.result === "mismatch" || llmResult.result === "partial_match") {
    await writePendingAlert({
      reason: "reconciliation_mismatch",
      reconciliation_result: llmResult.result,
      pending_code_change_id: pendingChange.id,
      ordinance_provision_id: provision.id,
      municode_node_id: pendingChange.municode_node_id,
      supplement_job_id: supplementJobId,
      notes: llmResult.notes,
    });
  }
  // "not_found": leave pending_code_changes unchanged, no alert

  return { skipped: false, result: llmResult.result };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return error("NOT_FOUND", "Method not allowed", 405);
  }

  let supplementJobId: string;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.supplement_job_id || typeof body.supplement_job_id !== "string") {
      return error("INGESTION_FAILED", "supplement_job_id is required in request body", 400);
    }
    supplementJobId = body.supplement_job_id;
  } catch {
    return error("INGESTION_FAILED", "Invalid JSON request body", 400);
  }

  try {
    const { data: pendingChanges, error: pcErr } = await db
      .from("pending_code_changes")
      .select("id, municode_node_id, proposed_text, on_spot_edits, document_id")
      .eq("codification_status", "pending");

    if (pcErr) {
      console.error("[reconciliation] pending_code_changes lookup failed:", pcErr.message);
      return error("INGESTION_FAILED", "Failed to load pending code changes", 500);
    }

    const changes = (pendingChanges ?? []) as PendingCodeChange[];

    if (changes.length === 0) {
      return success({ reconciled: 0, skipped: 0, no_provision_found: 0, results: [] });
    }

    const nodeIds = [...new Set(changes.map((pc) => pc.municode_node_id))];

    const { data: provisions, error: provErr } = await db
      .from("ordinance_provisions")
      .select("id, municode_node_id, content, document_id")
      .eq("is_current", true)
      .in("municode_node_id", nodeIds);

    if (provErr) {
      console.error("[reconciliation] ordinance_provisions lookup failed:", provErr.message);
      return error("INGESTION_FAILED", "Failed to load ordinance provisions", 500);
    }

    // Build node_id → provision lookup (one current provision per node, enforced by DB index)
    const provisionByNodeId = new Map<string, OrdinanceProvision>();
    for (const p of (provisions ?? []) as OrdinanceProvision[]) {
      provisionByNodeId.set(p.municode_node_id, p);
    }

    type PairResult =
      | { pending_code_change_id: string; ordinance_provision_id: string; result: ReconciliationResult; skipped: boolean }
      | { pending_code_change_id: string; error: string };

    const results: PairResult[] = [];
    let reconciledCount = 0;
    let skippedCount = 0;
    let noProvisionCount = 0;

    for (const pc of changes) {
      const provision = provisionByNodeId.get(pc.municode_node_id);

      if (!provision) {
        noProvisionCount++;
        continue;
      }

      try {
        const outcome = await reconcilePair(pc, provision, supplementJobId);
        if (outcome.skipped) {
          skippedCount++;
        } else {
          reconciledCount++;
        }
        results.push({
          pending_code_change_id: pc.id,
          ordinance_provision_id: provision.id,
          result: outcome.result ?? "not_found",
          skipped: outcome.skipped,
        });
      } catch (e) {
        const message = (e as Error).message;
        console.error("[reconciliation] pair failed:", message);
        results.push({ pending_code_change_id: pc.id, error: message });
      }
    }

    return success({
      reconciled: reconciledCount,
      skipped: skippedCount,
      no_provision_found: noProvisionCount,
      results,
    });
  } catch (e) {
    console.error("[reconciliation] fatal error:", (e as Error).message);
    return error("INGESTION_FAILED", "Reconciliation failed", 500);
  }
});
