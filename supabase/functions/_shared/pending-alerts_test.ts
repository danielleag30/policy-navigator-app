import {
  aiSessionDeferredAlertDedupeKey,
  aiSessionDeferredAlertDetails,
  aiSessionDeferredAlertMessage,
  type PendingAlertRpcDb,
  recordAiSessionDeferredPendingAlert,
} from "./pending-alerts.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

interface AlertRow {
  alert_type: "ingestion_failure";
  details: Record<string, unknown>;
  dedupe_key: string | null;
  triggered_at: string;
  last_seen_at: string;
  occurrence_count: number;
}

class FakePendingAlertDb implements PendingAlertRpcDb {
  rows: AlertRow[] = [];

  rpc(fn: "upsert_pending_alert", args: {
    p_alert_type: "ingestion_failure";
    p_details: Record<string, unknown>;
    p_dedupe_key: string | null;
    p_triggered_at: string;
  }): Promise<{ data: string | null; error: { message: string } | null }> {
    assertEquals(fn, "upsert_pending_alert");

    const existing = args.p_dedupe_key
      ? this.rows.find((row) => row.dedupe_key === args.p_dedupe_key)
      : undefined;

    if (existing) {
      existing.details = args.p_details;
      existing.triggered_at = args.p_triggered_at;
      existing.last_seen_at = args.p_triggered_at;
      existing.occurrence_count += 1;
      return Promise.resolve({ data: "existing-alert-id", error: null });
    }

    this.rows.push({
      alert_type: args.p_alert_type,
      details: args.p_details,
      dedupe_key: args.p_dedupe_key,
      triggered_at: args.p_triggered_at,
      last_seen_at: args.p_triggered_at,
      occurrence_count: 1,
    });
    return Promise.resolve({ data: "new-alert-id", error: null });
  }
}

Deno.test("AI-session deferral alert details keep the legacy message and add a reason", () => {
  assertEquals(
    aiSessionDeferredAlertMessage("ai_session_unavailable"),
    "AI Session unavailable (ai_session_unavailable) — deferred without consuming retry",
  );
  assertEquals(
    aiSessionDeferredAlertDetails("pending-1", "ai_session_unavailable"),
    {
      pending_ingestion_id: "pending-1",
      reason: "ai_session_unavailable",
      message: "AI Session unavailable (ai_session_unavailable) — deferred without consuming retry",
    },
  );
  assertEquals(
    aiSessionDeferredAlertDedupeKey("pending-1", "ai_session_unavailable"),
    "pending_ingestion:pending-1:ai_session_defer:ai_session_unavailable",
  );
});

Deno.test("repeated AI-session deferrals for the same pending ingestion update one alert row", async () => {
  const db = new FakePendingAlertDb();

  await recordAiSessionDeferredPendingAlert(db, "pending-1", "ai_session_unavailable", {
    nowIso: () => "2026-07-17T03:00:00.000Z",
  });
  await recordAiSessionDeferredPendingAlert(db, "pending-1", "ai_session_unavailable", {
    nowIso: () => "2026-07-17T03:03:00.000Z",
  });

  assertEquals(db.rows.length, 1);
  assertEquals(
    db.rows[0].dedupe_key,
    "pending_ingestion:pending-1:ai_session_defer:ai_session_unavailable",
  );
  assertEquals(db.rows[0].occurrence_count, 2);
  assertEquals(db.rows[0].triggered_at, "2026-07-17T03:03:00.000Z");
  assertEquals(db.rows[0].last_seen_at, "2026-07-17T03:03:00.000Z");
});

Deno.test("AI-session deferral dedupe key is scoped by pending ingestion and reason", async () => {
  const db = new FakePendingAlertDb();

  await recordAiSessionDeferredPendingAlert(db, "pending-1", "ai_session_unavailable", {
    nowIso: () => "2026-07-17T03:00:00.000Z",
  });
  await recordAiSessionDeferredPendingAlert(db, "pending-2", "ai_session_unavailable", {
    nowIso: () => "2026-07-17T03:00:00.000Z",
  });
  await recordAiSessionDeferredPendingAlert(db, "pending-1", "ai_session_construct_failed", {
    nowIso: () => "2026-07-17T03:00:00.000Z",
  });

  assertEquals(db.rows.length, 3);
  assert(
    db.rows.every((row) => row.occurrence_count === 1),
    "distinct pending ingestion/reason pairs must remain separate alerts",
  );
});
