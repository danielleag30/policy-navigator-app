import {
  type AcknowledgeAlertDb,
  ADMIN_SECRET_HEADER,
  handleAcknowledgeAlert,
  type PendingAlertRow,
} from "./handler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const ALERT_ID = "018f4d8a-8a46-7c46-9c46-2a9f688f1d3a";
const SECRET = "local-admin-secret";

function row(overrides: Partial<PendingAlertRow> = {}): PendingAlertRow {
  return {
    id: ALERT_ID,
    alert_type: "ingestion_failure",
    details: { pending_ingestion_id: "018f4d8a-8a46-7c46-9c46-2a9f688f1d3b" },
    triggered_at: "2026-06-23T12:00:00.000Z",
    acknowledged: false,
    acknowledged_at: null,
    created_at: "2026-06-23T12:00:00.000Z",
    ...overrides,
  };
}

class FakeDb implements AcknowledgeAlertDb {
  calls = 0;
  updates: Partial<PendingAlertRow>[] = [];

  constructor(
    private existing: PendingAlertRow | null,
    private lookupError: { message: string } | null = null,
    private updateError: { message: string } | null = null,
  ) {}

  from(table: "pending_alerts") {
    assertEquals(table, "pending_alerts");
    this.calls++;
    return {
      select: (_columns: string) => ({
        eq: (_column: "id", _value: string) => ({
          maybeSingle: () =>
            Promise.resolve({
              data: this.existing,
              error: this.lookupError,
            }),
        }),
      }),
      update: (values: Partial<PendingAlertRow>) => ({
        eq: (_column: "id", _value: string) => ({
          select: (_columns: string) => ({
            single: () => {
              this.updates.push(values);
              if (this.updateError) {
                return Promise.resolve({ data: null, error: this.updateError });
              }
              this.existing = { ...this.existing!, ...values };
              return Promise.resolve({ data: this.existing, error: null });
            },
          }),
        }),
      }),
    };
  }
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json();
}

function request(
  init: {
    method?: string;
    id?: string;
    secret?: string;
    headerName?: string;
    rawBody?: string;
  } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.secret) {
    headers.set(init.headerName ?? ADMIN_SECRET_HEADER, init.secret);
  }

  return new Request("http://localhost/acknowledge-alert", {
    method: init.method ?? "POST",
    headers,
    body: init.rawBody ?? JSON.stringify({ id: init.id ?? ALERT_ID }),
  });
}

Deno.test("wrong admin secret returns 401 without database access", async () => {
  const db = new FakeDb(row());
  const response = await handleAcknowledgeAlert(request({ secret: "wrong" }), {
    db,
    adminSecret: SECRET,
  });

  assertEquals(response.status, 401);
  assertEquals(db.calls, 0);
  assertEquals(await bodyOf(response), {
    ok: false,
    error: { code: "UNAUTHORIZED", message: "Unauthorized" },
  });
});

Deno.test("missing configured admin secret returns 500 without database access", async () => {
  const db = new FakeDb(row());
  const response = await handleAcknowledgeAlert(request({ secret: SECRET }), {
    db,
    adminSecret: undefined,
  });

  assertEquals(response.status, 500);
  assertEquals(db.calls, 0);
});

Deno.test("valid secret with missing alert ID returns 404", async () => {
  const db = new FakeDb(null);
  const response = await handleAcknowledgeAlert(request({ secret: SECRET }), {
    db,
    adminSecret: SECRET,
  });

  assertEquals(response.status, 404);
  assertEquals(db.calls, 1);
  assertEquals(await bodyOf(response), {
    ok: false,
    error: { code: "NOT_FOUND", message: "Pending alert not found." },
  });
});

Deno.test("valid secret acknowledges an unacknowledged alert", async () => {
  const db = new FakeDb(row());
  const response = await handleAcknowledgeAlert(request({ secret: SECRET }), {
    db,
    adminSecret: SECRET,
    now: () => new Date("2026-06-23T13:14:15.000Z"),
  });
  const body = await bodyOf(response) as { ok: boolean; data: PendingAlertRow };

  assertEquals(response.status, 200);
  assertEquals(db.calls, 2);
  assertEquals(db.updates, [
    { acknowledged: true, acknowledged_at: "2026-06-23T13:14:15.000Z" },
  ]);
  assert(body.ok, "expected success envelope");
  assertEquals(body.data.acknowledged, true);
  assertEquals(body.data.acknowledged_at, "2026-06-23T13:14:15.000Z");
});

Deno.test("already acknowledged alert is idempotent and returns existing row", async () => {
  const existing = row({
    acknowledged: true,
    acknowledged_at: "2026-06-23T12:30:00.000Z",
  });
  const db = new FakeDb(existing);
  const response = await handleAcknowledgeAlert(request({ secret: SECRET }), {
    db,
    adminSecret: SECRET,
    now: () => new Date("2026-06-23T13:14:15.000Z"),
  });
  const body = await bodyOf(response) as { ok: boolean; data: PendingAlertRow };

  assertEquals(response.status, 200);
  assertEquals(db.calls, 1);
  assertEquals(db.updates, []);
  assert(body.ok, "expected success envelope");
  assertEquals(body.data, existing);
});

Deno.test("authorization bearer secret is accepted", async () => {
  const db = new FakeDb(row());
  const response = await handleAcknowledgeAlert(
    request({ secret: `Bearer ${SECRET}`, headerName: "authorization" }),
    {
      db,
      adminSecret: SECRET,
      now: () => new Date("2026-06-23T13:14:15.000Z"),
    },
  );

  assertEquals(response.status, 200);
  assertEquals(db.calls, 2);
});
