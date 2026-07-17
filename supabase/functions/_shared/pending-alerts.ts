/**
 * Helpers for pending_alerts write paths that need database-level dedupe.
 */

interface DbError {
  message: string;
}

interface UpsertPendingAlertArgs {
  p_alert_type: "ingestion_failure";
  p_details: Record<string, unknown>;
  p_dedupe_key: string | null;
  p_triggered_at: string;
}

export interface PendingAlertRpcDb {
  rpc(
    fn: "upsert_pending_alert",
    args: UpsertPendingAlertArgs,
  ): PromiseLike<{ data: string | null; error: DbError | null }>;
}

export interface RecordPendingAlertOptions {
  nowIso?: () => string;
}

export function aiSessionDeferredAlertMessage(reason: string): string {
  return `AI Session unavailable (${reason}) — deferred without consuming retry`;
}

export function aiSessionDeferredAlertDedupeKey(
  pendingIngestionId: string,
  reason: string,
): string {
  return `pending_ingestion:${pendingIngestionId}:ai_session_defer:${reason}`;
}

export function aiSessionDeferredAlertDetails(
  pendingIngestionId: string,
  reason: string,
): Record<string, unknown> {
  return {
    pending_ingestion_id: pendingIngestionId,
    reason,
    message: aiSessionDeferredAlertMessage(reason),
  };
}

export async function recordAiSessionDeferredPendingAlert(
  db: PendingAlertRpcDb,
  pendingIngestionId: string,
  reason: string,
  options: RecordPendingAlertOptions = {},
): Promise<void> {
  const triggeredAt = (options.nowIso ?? (() => new Date().toISOString()))();
  const { error } = await db.rpc("upsert_pending_alert", {
    p_alert_type: "ingestion_failure",
    p_details: aiSessionDeferredAlertDetails(pendingIngestionId, reason),
    p_dedupe_key: aiSessionDeferredAlertDedupeKey(pendingIngestionId, reason),
    p_triggered_at: triggeredAt,
  });

  if (error) {
    throw new Error(`Failed to write PendingAlert: ${error.message}`);
  }
}
