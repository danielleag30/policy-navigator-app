export interface ClaimedPendingIngestion {
  id: string;
  url: string;
  doc_type: string;
  attempts: number | null;
  status: string;
}

export interface PendingIngestionClaim {
  row: ClaimedPendingIngestion;
  newAttempts: number;
}

export type ClaimNextResult =
  | { kind: "claimed"; claim: PendingIngestionClaim }
  | { kind: "idle" }
  | { kind: "claim_lost" }
  | { kind: "skipped"; id: string; reason: string };

export interface ProcessedIngestionResult {
  id: string;
  ok: boolean;
  status: number;
  data?: unknown;
  error?: unknown;
}

export interface LoopRowResult {
  id: string;
  outcome: "processed" | "failed" | "skipped" | "claim_lost";
  status?: number;
  data?: unknown;
  error?: string;
}

export interface PendingIngestionLoopResult {
  status: "idle" | "processed" | "deadline_reached";
  claimed: number;
  processed: number;
  failed: number;
  skipped: number;
  claimLost: number;
  rows: LoopRowResult[];
}

export interface PendingIngestionLoopOptions {
  deadlineMs: number;
  claimNext: () => Promise<ClaimNextResult>;
  processClaim: (
    claim: PendingIngestionClaim,
  ) => Promise<ProcessedIngestionResult>;
  now?: () => number;
  onRowError?: (id: string, error: Error) => void;
}

/**
 * Sequentially claims and processes pending_ingestions rows until either the
 * queue is empty or the caller's soft deadline has been reached. This loop
 * intentionally awaits each row before claiming the next one; do not introduce
 * Promise.all/concurrent work here.
 */
export async function runPendingIngestionLoop(
  options: PendingIngestionLoopOptions,
): Promise<PendingIngestionLoopResult> {
  const now = options.now ?? Date.now;
  const rows: LoopRowResult[] = [];
  let claimed = 0;
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let claimLost = 0;
  let stoppedForDeadline = false;

  while (true) {
    if (now() >= options.deadlineMs) {
      stoppedForDeadline = true;
      break;
    }

    const next = await options.claimNext();
    if (next.kind === "idle") {
      break;
    }
    if (next.kind === "claim_lost") {
      claimLost += 1;
      rows.push({ id: "", outcome: "claim_lost" });
      continue;
    }
    if (next.kind === "skipped") {
      skipped += 1;
      rows.push({
        id: next.id,
        outcome: "skipped",
        data: { reason: next.reason },
      });
      continue;
    }

    const { claim } = next;
    claimed += 1;
    try {
      const result = await options.processClaim(claim);
      if (result.ok) {
        processed += 1;
        rows.push({
          id: result.id,
          outcome: "processed",
          status: result.status,
          data: result.data,
        });
      } else {
        failed += 1;
        rows.push({
          id: result.id,
          outcome: "failed",
          status: result.status,
          error: JSON.stringify(result.error ?? result.data ?? null),
        });
      }
    } catch (e) {
      failed += 1;
      const err = e instanceof Error ? e : new Error(String(e));
      options.onRowError?.(claim.row.id, err);
      rows.push({
        id: claim.row.id,
        outcome: "failed",
        error: err.message,
      });
    }
  }

  return {
    status: stoppedForDeadline
      ? "deadline_reached"
      : claimed === 0 && processed === 0 && skipped === 0
      ? "idle"
      : "processed",
    claimed,
    processed,
    failed,
    skipped,
    claimLost,
    rows,
  };
}
