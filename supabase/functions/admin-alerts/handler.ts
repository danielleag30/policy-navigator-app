import { ADMIN_SECRET_HEADER, verifyAdminSecret } from "../_shared/admin-auth.ts";

export { ADMIN_SECRET_HEADER };
import { logError, logInfo } from "../_shared/logger.ts";
import { corsPreflightResponse, error, success } from "../_shared/response.ts";

const FUNCTION_NAME = "admin-alerts";

export interface PendingAlertRow {
  id: string;
  alert_type: string;
  details: unknown;
  triggered_at: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
  created_at: string;
}

interface DbError {
  message: string;
}

export interface AdminAlertsDb {
  from(table: "pending_alerts"): {
    select(columns: string): {
      eq(column: "acknowledged", value: boolean): {
        order(
          column: "triggered_at",
          opts: { ascending: boolean },
        ): Promise<{ data: PendingAlertRow[] | null; error: DbError | null }>;
      };
    };
  };
}

export interface HandlerDeps {
  db: AdminAlertsDb;
  adminSecret: string | undefined;
}

export async function handleAdminAlerts(
  req: Request,
  { db, adminSecret }: HandlerDeps,
): Promise<Response> {
  logInfo(FUNCTION_NAME, "request started", { method: req.method });

  if (req.method === "OPTIONS") {
    return corsPreflightResponse();
  }

  if (req.method !== "GET") {
    logError(FUNCTION_NAME, "method not allowed", { method: req.method });
    return error("NOT_FOUND", "Method not allowed", 405);
  }

  if (!adminSecret) {
    logError(FUNCTION_NAME, "admin secret is not configured");
    return error("INGESTION_FAILED", "Admin secret is not configured.", 500);
  }

  if (!verifyAdminSecret(req, adminSecret)) {
    logError(FUNCTION_NAME, "unauthorized request");
    return error("UNAUTHORIZED", "Unauthorized", 401);
  }

  const { data, error: dbErr } = await db
    .from("pending_alerts")
    .select("*")
    .eq("acknowledged", false)
    .order("triggered_at", { ascending: false });

  if (dbErr) {
    logError(FUNCTION_NAME, "pending_alerts query failed", {
      message: dbErr.message,
    });
    return error("INGESTION_FAILED", "Failed to load pending alerts.", 500);
  }

  logInfo(FUNCTION_NAME, "request completed", { count: data?.length ?? 0 });
  return success(data ?? []);
}
