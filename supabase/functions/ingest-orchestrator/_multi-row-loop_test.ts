import {
  type ClaimNextResult,
  type PendingIngestionClaim,
  runPendingIngestionLoop,
} from "./_multi-row-loop.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

function claim(id: string): PendingIngestionClaim {
  return {
    row: {
      id,
      url: `https://example.test/${id}.pdf`,
      doc_type: "bos_minutes",
      attempts: 1,
      status: "processing",
    },
    newAttempts: 2,
  };
}

Deno.test("deadline-based stop checks time before claiming another row", async () => {
  let now = 0;
  let claimCalls = 0;
  const processed: string[] = [];

  const result = await runPendingIngestionLoop({
    deadlineMs: 10,
    now: () => now,
    claimNext: () => {
      claimCalls++;
      return Promise.resolve({
        kind: "claimed",
        claim: claim(`row-${claimCalls}`),
      });
    },
    processClaim: (next) => {
      processed.push(next.row.id);
      now = 10;
      return Promise.resolve({
        id: next.row.id,
        ok: true,
        status: 200,
        data: { status: "done" },
      });
    },
  });

  assertEquals(processed, ["row-1"]);
  assertEquals(claimCalls, 1);
  assertEquals(result.status, "deadline_reached");
  assertEquals(result.claimed, 1);
  assertEquals(result.processed, 1);
});

Deno.test("per-row failure isolation continues after a bad row", async () => {
  const ids = ["good-1", "bad-2", "good-3"];
  const attempted: string[] = [];

  const result = await runPendingIngestionLoop({
    deadlineMs: 100,
    now: () => 0,
    claimNext: () => {
      const id = ids.shift();
      return Promise.resolve(
        id ? { kind: "claimed", claim: claim(id) } : { kind: "idle" },
      );
    },
    processClaim: (next) => {
      attempted.push(next.row.id);
      if (next.row.id === "bad-2") {
        return Promise.reject(new Error("malformed PDF"));
      }
      return Promise.resolve({
        id: next.row.id,
        ok: true,
        status: 200,
        data: { status: "done" },
      });
    },
  });

  assertEquals(attempted, ["good-1", "bad-2", "good-3"]);
  assertEquals(result.claimed, 3);
  assertEquals(result.processed, 2);
  assertEquals(result.failed, 1);
  assert(
    result.rows.some((row) => row.id === "bad-2" && row.outcome === "failed"),
    "failed row must be recorded without aborting the loop",
  );
});

Deno.test("atomic claim behavior prevents double-processing under concurrent loops", async () => {
  const table = [
    { id: "row-1", status: "pending" },
    { id: "row-2", status: "pending" },
    { id: "row-3", status: "pending" },
  ];
  const processed: string[] = [];

  async function atomicClaimNext(): Promise<ClaimNextResult> {
    const selected = table.find((row) => row.status === "pending");
    if (!selected) return { kind: "idle" };

    // Simulate the SELECT/UPDATE gap. Both loops may observe the same selected
    // row, but only the conditional update of status=pending can claim it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (selected.status !== "pending") {
      return { kind: "claim_lost" };
    }
    selected.status = "processing";
    return { kind: "claimed", claim: claim(selected.id) };
  }

  function processClaim(next: PendingIngestionClaim) {
    processed.push(next.row.id);
    const row = table.find((candidate) => candidate.id === next.row.id);
    if (row) row.status = "done";
    return Promise.resolve({
      id: next.row.id,
      ok: true,
      status: 200,
      data: { status: "done" },
    });
  }

  await Promise.all([
    runPendingIngestionLoop({
      deadlineMs: 100,
      now: () => 0,
      claimNext: atomicClaimNext,
      processClaim,
    }),
    runPendingIngestionLoop({
      deadlineMs: 100,
      now: () => 0,
      claimNext: atomicClaimNext,
      processClaim,
    }),
  ]);

  assertEquals(processed.sort(), ["row-1", "row-2", "row-3"]);
  assertEquals(new Set(processed).size, processed.length);
  assertEquals(table.map((row) => row.status), ["done", "done", "done"]);
});
