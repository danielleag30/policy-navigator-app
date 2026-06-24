import {
  ADMIN_SECRET_HEADER,
  requestSecret,
} from "../_shared/admin-auth.ts";
import { logError, logInfo } from "../_shared/logger.ts";
import { error, success } from "../_shared/response.ts";

export { ADMIN_SECRET_HEADER };
const FUNCTION_NAME = "acknowledge-alert";

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

export interface AcknowledgeAlertDb {
  from(table: "pending_alerts"): {
    select(columns: string): {
      eq(column: "id", value: string): {
        maybeSingle(): Promise<
          { data: PendingAlertRow | null; error: DbError | null }
        >;
      };
    };
    update(values: Partial<PendingAlertRow>): {
      eq(column: "id", value: string): {
        select(columns: string): {
          single(): Promise<
            { data: PendingAlertRow | null; error: DbError | null }
          >;
        };
      };
    };
  };
}

interface HandlerDeps {
  db: AcknowledgeAlertDb;
  adminSecret: string | undefined;
  now?: () => Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export async function handleAcknowledgeAlert(
  req: Request,
  { db, adminSecret, now = () => new Date() }: HandlerDeps,
): Promise<Response> {
  logInfo(FUNCTION_NAME, "request started", { method: req.method });

  if (req.method !== "POST") {
    logError(FUNCTION_NAME, "method not allowed", { method: req.method });
    return error("NOT_FOUND", "Method not allowed", 405);
  }

  if (!adminSecret) {
    logError(FUNCTION_NAME, "admin secret is not configured");
    return error("INGESTION_FAILED", "Admin secret is not configured.", 500);
  }

  if (requestSecret(req) !== adminSecret) {
    logError(FUNCTION_NAME, "unauthorized request");
    return error("UNAUTHORIZED", "Unauthorized", 401);
  }

  let alertId: string;
  try {
    const body = (await req.json()) as {
      id?: unknown;
      pending_alert_id?: unknown;
    };
    const candidate = body.id ?? body.pending_alert_id;
    if (!isValidUuid(candidate)) {
      logError(FUNCTION_NAME, "invalid alert id in request body");
      return error(
        "NOT_FOUND",
        "Request body must contain a valid `id` UUID.",
        400,
      );
    }
    alertId = candidate;
  } catch {
    logError(FUNCTION_NAME, "invalid JSON body");
    return error("NOT_FOUND", "Invalid JSON body.", 400);
  }

  const { data: existing, error: lookupErr } = await db
    .from("pending_alerts")
    .select("*")
    .eq("id", alertId)
    .maybeSingle();

  if (lookupErr) {
    logError(FUNCTION_NAME, "pending_alert lookup failed", {
      message: lookupErr.message,
    });
    return error("INGESTION_FAILED", "Failed to load pending alert.", 500);
  }

  if (!existing) {
    logError(FUNCTION_NAME, "pending_alert not found", { id: alertId });
    return error("NOT_FOUND", "Pending alert not found.", 404);
  }

  if (existing.acknowledged) {
    logInfo(FUNCTION_NAME, "request completed", {
      id: alertId,
      alreadyAcknowledged: true,
    });
    return success(existing);
  }

  const { data: updated, error: updateErr } = await db
    .from("pending_alerts")
    .update({
      acknowledged: true,
      acknowledged_at: now().toISOString(),
    })
    .eq("id", alertId)
    .select("*")
    .single();

  if (updateErr || !updated) {
    logError(FUNCTION_NAME, "pending_alert acknowledge failed", {
      id: alertId,
      message: updateErr?.message ?? "no row returned",
    });
    return error(
      "INGESTION_FAILED",
      "Failed to acknowledge pending alert.",
      500,
    );
  }

  logInfo(FUNCTION_NAME, "request completed", {
    id: alertId,
    alreadyAcknowledged: false,
  });
  return success(updated);
}
