import {
  type ReconciliationTriggerDb,
  triggerReconciliationIfNeeded,
} from "./_reconciliation-trigger.ts";

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

class FakeDb implements ReconciliationTriggerDb {
  constructor(private pendingRows: Array<{ id: string }>) {}

  from(table: "pending_code_changes") {
    assertEquals(table, "pending_code_changes");
    return {
      select: (columns: "id") => {
        assertEquals(columns, "id");
        return {
          in: (column: "municode_node_id", values: string[]) => {
            assertEquals(column, "municode_node_id");
            assertEquals(values, ["node-1"]);
            return {
              eq: (statusColumn: "codification_status", status: "pending") => {
                assertEquals(statusColumn, "codification_status");
                assertEquals(status, "pending");
                return Promise.resolve({ data: this.pendingRows, error: null });
              },
            };
          },
        };
      },
    };
  }
}

Deno.test("triggerReconciliationIfNeeded sends reconciliation's supplement job payload", async () => {
  let capturedUrl: string | null = null;
  let capturedInit: RequestInit | undefined;

  const triggered = await triggerReconciliationIfNeeded({
    db: new FakeDb([{ id: "pending-change-1" }]),
    nodeIds: ["node-1"],
    supplementJobId: "municode-job-123",
    pendingIngestionId: "018f4d8a-8a46-7c46-9c46-2a9f688f1d3b",
    getEnv: (name) =>
      ({
        SUPABASE_URL: "https://project-ref.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      })[name],
    fetchImpl: (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    logger: {
      error: () => undefined,
      log: () => undefined,
      warn: () => undefined,
    },
  });

  assert(triggered, "expected reconciliation to be triggered");
  assertEquals(
    capturedUrl,
    "https://project-ref.supabase.co/functions/v1/reconciliation",
  );

  const body = JSON.parse(String(capturedInit?.body));
  assertEquals(body, {
    supplement_job_id: "municode-job-123",
    pending_ingestion_id: "018f4d8a-8a46-7c46-9c46-2a9f688f1d3b",
  });
  assert(
    !("document_id" in body),
    "document_id must not be sent to reconciliation",
  );
  assertEquals(capturedInit?.headers, {
    Authorization: "Bearer service-role-key",
    "Content-Type": "application/json",
  });
});
