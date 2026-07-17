import { reconciliationInvokeUrl } from "./_reconciliation-url.ts";

interface DbError {
  message: string;
}

interface QueryResult<T> {
  data: T | null;
  error: DbError | null;
}

interface PendingCodeChangesTable {
  select(columns: "id"): {
    in(column: "municode_node_id", values: string[]): {
      eq(
        column: "codification_status",
        value: "pending",
      ): PromiseLike<QueryResult<Array<{ id: string }>>>;
    };
  };
}

export interface ReconciliationTriggerDb {
  from(table: "pending_code_changes"): PendingCodeChangesTable;
}

interface ReconciliationTriggerOptions {
  db: ReconciliationTriggerDb;
  nodeIds: string[];
  supplementJobId: string;
  pendingIngestionId: string;
  fetchImpl?: typeof fetch;
  getEnv?: (name: string) => string | undefined;
  logger?: Pick<Console, "error" | "log" | "warn">;
}

export async function triggerReconciliationIfNeeded(
  {
    db,
    nodeIds,
    supplementJobId,
    pendingIngestionId,
    fetchImpl = fetch,
    getEnv = (name) => Deno.env.get(name),
    logger = console,
  }: ReconciliationTriggerOptions,
): Promise<boolean> {
  if (nodeIds.length === 0) return false;

  const { data: pending, error: pendingErr } = await db
    .from("pending_code_changes")
    .select("id")
    .in("municode_node_id", nodeIds)
    .eq("codification_status", "pending");

  if (pendingErr) {
    logger.error(
      "[orchestrator] PendingCodeChange lookup failed:",
      pendingErr.message,
    );
    return false;
  }

  if (!pending || pending.length === 0) return false;

  logger.log(
    `[orchestrator] ${pending.length} overlapping PendingCodeChange(s) found — triggering reconciliation`,
  );

  const supabaseUrl = getEnv("SUPABASE_URL");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    logger.error("[orchestrator] missing env vars for reconciliation invoke");
    return false;
  }

  try {
    const resp = await fetchImpl(
      reconciliationInvokeUrl(supabaseUrl),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          supplement_job_id: supplementJobId,
          pending_ingestion_id: pendingIngestionId,
        }),
      },
    );
    if (!resp.ok) {
      logger.warn(
        `[orchestrator] reconciliation returned HTTP ${resp.status}`,
      );
      return false;
    }
    logger.log("[orchestrator] reconciliation triggered successfully");
    return true;
  } catch (e) {
    // Reconciliation function may not yet be deployed -- log and continue.
    logger.warn(
      "[orchestrator] reconciliation invoke failed (may not be deployed):",
      (e as Error).message,
    );
    return false;
  }
}
