import {
  type AdminAlertsDb,
  ADMIN_SECRET_HEADER,
  type HandlerDeps,
  handleAdminAlerts,
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

const SECRET = "local-admin-secret";

function row(overrides: Partial<PendingAlertRow> = {}): PendingAlertRow {
  return {
    id: "018f4d8a-8a46-7c46-9c46-2a9f688f1d3a",
    alert_type: "ingestion_failure",
    details: { pending_ingestion_id: "018f4d8a-8a46-7c46-9c46-2a9f688f1d3b" },
    triggered_at: "2026-06-23T12:00:00.000Z",
    acknowledged: false,
    acknowledged_at: null,
    created_at: "2026-06-23T12:00:00.000Z",
    ...overrides,
  };
}

class FakeDb implements AdminAlertsDb {
  calls = 0;

  constructor(
    private rows: PendingAlertRow[],
    private queryError: { message: string } | null = null,
  ) {}

  from(table: "pending_alerts") {
    assertEquals(table, "pending_alerts");
    this.calls++;
    return {
      select: (_columns: string) => ({
        eq: (_column: "acknowledged", _value: boolean) => ({
          order: (
            _column: "triggered_at",
            _opts: { ascending: boolean },
          ) =>
            Promise.resolve({
              data: this.queryError ? null : this.rows,
              error: this.queryError,
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
    secret?: string;
    headerName?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (init.secret) {
    headers.set(init.headerName ?? ADMIN_SECRET_HEADER, init.secret);
  }
  return new Request("http://localhost/admin-alerts", {
    method: init.method ?? "GET",
    headers,
  });
}

function deps(
  db: AdminAlertsDb,
  adminSecret: string | undefined = SECRET,
): HandlerDeps {
  return { db, adminSecret };
}

Deno.test("wrong admin secret returns 401 without database access", async () => {
  const db = new FakeDb([row()]);
  const response = await handleAdminAlerts(
    request({ secret: "wrong" }),
    deps(db),
  );

  assertEquals(response.status, 401);
  assertEquals(db.calls, 0);
  assertEquals(await bodyOf(response), {
    ok: false,
    error: { code: "UNAUTHORIZED", message: "Unauthorized" },
  });
});

Deno.test("missing admin secret header returns 401 without database access", async () => {
  const db = new FakeDb([row()]);
  const response = await handleAdminAlerts(request(), deps(db));

  assertEquals(response.status, 401);
  assertEquals(db.calls, 0);
});

Deno.test("unconfigured ADMIN_SECRET returns 500 without database access", async () => {
  const db = new FakeDb([row()]);
  const response = await handleAdminAlerts(
    request({ secret: SECRET }),
    { db, adminSecret: undefined },
  );

  assertEquals(response.status, 500);
  assertEquals(db.calls, 0);
  assertEquals(await bodyOf(response), {
    ok: false,
    error: {
      code: "INGESTION_FAILED",
      message: "Admin secret is not configured.",
    },
  });
});

Deno.test("non-GET method returns 405", async () => {
  const db = new FakeDb([]);
  const response = await handleAdminAlerts(
    request({ method: "POST", secret: SECRET }),
    deps(db),
  );

  assertEquals(response.status, 405);
  assertEquals(db.calls, 0);
  assertEquals(await bodyOf(response), {
    ok: false,
    error: { code: "NOT_FOUND", message: "Method not allowed" },
  });
});

Deno.test("returns empty array when no unacknowledged alerts exist", async () => {
  const db = new FakeDb([]);
  const response = await handleAdminAlerts(
    request({ secret: SECRET }),
    deps(db),
  );
  const body = await bodyOf(response);

  assertEquals(response.status, 200);
  assertEquals(db.calls, 1);
  assert(body.ok, "expected success envelope");
  assertEquals(body.data, []);
});

Deno.test("returns only unacknowledged alerts sorted by triggered_at DESC", async () => {
  const older = row({
    id: "018f4d8a-8a46-7c46-9c46-2a9f688f1d3c",
    triggered_at: "2026-06-23T10:00:00.000Z",
  });
  const newer = row({
    id: "018f4d8a-8a46-7c46-9c46-2a9f688f1d3a",
    triggered_at: "2026-06-23T12:00:00.000Z",
  });
  // FakeDb returns rows in the order supplied (simulating ORDER BY triggered_at DESC)
  const db = new FakeDb([newer, older]);
  const response = await handleAdminAlerts(
    request({ secret: SECRET }),
    deps(db),
  );
  const body = await bodyOf(response) as {
    ok: boolean;
    data: PendingAlertRow[];
  };

  assertEquals(response.status, 200);
  assertEquals(db.calls, 1);
  assert(body.ok, "expected success envelope");
  assertEquals(body.data.length, 2);
  assertEquals(body.data[0].id, newer.id);
  assertEquals(body.data[1].id, older.id);
});

Deno.test("details JSONB is returned as object (not stringified)", async () => {
  const details = { pending_ingestion_id: "abc-123", extra: { nested: true } };
  const db = new FakeDb([row({ details })]);
  const response = await handleAdminAlerts(
    request({ secret: SECRET }),
    deps(db),
  );
  const body = await bodyOf(response) as {
    ok: boolean;
    data: PendingAlertRow[];
  };

  assertEquals(response.status, 200);
  assert(body.ok, "expected success envelope");
  assertEquals(typeof body.data[0].details, "object");
  assertEquals(body.data[0].details, details);
});

Deno.test("DB query error returns 500", async () => {
  const db = new FakeDb([], { message: "connection reset" });
  const response = await handleAdminAlerts(
    request({ secret: SECRET }),
    deps(db),
  );

  assertEquals(response.status, 500);
  assertEquals(db.calls, 1);
  assertEquals(await bodyOf(response), {
    ok: false,
    error: { code: "INGESTION_FAILED", message: "Failed to load pending alerts." },
  });
});

Deno.test("Authorization Bearer token is accepted", async () => {
  const db = new FakeDb([row()]);
  const response = await handleAdminAlerts(
    request({ secret: `Bearer ${SECRET}`, headerName: "authorization" }),
    deps(db),
  );

  assertEquals(response.status, 200);
  assertEquals(db.calls, 1);
});
