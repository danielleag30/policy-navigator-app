import {
  type BackfillDb,
  type BackfillResumeState,
  type BackfillRunRow,
  runBudgetCommitteeBackfill,
} from "../supabase/functions/budget-committee-backfill/_backfill.ts";
import type {
  DiscoverySource,
  PageFetchResult,
} from "../supabase/functions/change-detection/_discovery.ts";

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

const SOURCE: DiscoverySource = {
  id: "budget_committee_meeting",
  doc_type: "bos_minutes",
  label: "Budget Committee Meeting Records (budget domain)",
  discovery_urls: [
    "https://www.fairfaxcounty.gov/budget/budget-committee-meetings",
  ],
  discovery_depth: 2,
  discovery_link_prefix: "https://www.fairfaxcounty.gov/budget/",
  discovery_follow_min_year: 2024,
  allow_patterns: [
    "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/",
    "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/Documents/budget%20committee%20meeting/",
  ],
};

interface PendingRow {
  id: string;
  url: string;
  doc_type: string;
  status: string;
  [key: string]: unknown;
}

interface FakeResult {
  data?: unknown;
  count?: number | null;
  error: { message: string } | null;
}

class FakeDb {
  runs = new Map<string, BackfillRunRow>();
  pendingRows: PendingRow[] = [];
  currentDocuments = new Set<string>();

  from(table: "discovery_backfill_runs"): FakeTable;
  from(table: "documents"): FakeTable;
  from(table: "pending_ingestions"): FakeTable;
  from(table: string): FakeTable {
    return new FakeTable(this, table);
  }
}

class FakeTable {
  private filters: Record<string, unknown> = {};
  private statusIn: string[] | null = null;
  private mode: "select" | "insert" | "update" | null = null;
  private insertPayload: Record<string, unknown> | null = null;
  private updatePayload: Record<string, unknown> | null = null;
  private countHead = false;

  constructor(private db: FakeDb, private table: string) {}

  select(_columns: string, opts?: { count?: "exact"; head?: boolean }): this {
    if (this.mode === null) this.mode = "select";
    this.countHead = opts?.count === "exact" && opts?.head === true;
    return this;
  }

  insert(payload: Record<string, unknown>): this {
    this.mode = "insert";
    this.insertPayload = payload;
    return this;
  }

  update(payload: Record<string, unknown>): this {
    this.mode = "update";
    this.updatePayload = payload;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters[column] = value;
    return this;
  }

  in(column: string, values: string[]): this {
    if (column === "status") this.statusIn = values;
    return this;
  }

  maybeSingle(): Promise<FakeResult> {
    if (this.table !== "discovery_backfill_runs") {
      return Promise.resolve({ data: null, error: null });
    }
    const row = this.db.runs.get(String(this.filters.id));
    return Promise.resolve({ data: row ?? null, error: null });
  }

  single(): Promise<FakeResult> {
    if (this.mode === "insert" && this.table === "discovery_backfill_runs") {
      if (!this.insertPayload) throw new Error("Missing insert payload");
      const row = structuredClone(
        this.insertPayload,
      ) as unknown as BackfillRunRow;
      this.db.runs.set(
        String(this.insertPayload.id),
        row,
      );
      return Promise.resolve({
        data: structuredClone(row),
        error: null,
      });
    }

    if (this.mode === "update" && this.table === "discovery_backfill_runs") {
      if (!this.updatePayload) throw new Error("Missing update payload");
      const id = String(this.filters.id);
      const existing = this.db.runs.get(id);
      const next = {
        ...existing,
        ...structuredClone(this.updatePayload),
      } as BackfillRunRow;
      this.db.runs.set(id, next);
      return Promise.resolve({ data: structuredClone(next), error: null });
    }

    throw new Error(`Unsupported single() for ${this.table}`);
  }

  then(resolve: (value: FakeResult) => void): void {
    if (this.mode === "select" && this.countHead) {
      if (this.table === "documents") {
        const hit = this.db.currentDocuments.has(String(this.filters.url));
        resolve({ count: hit ? 1 : 0, error: null });
        return;
      }

      if (this.table === "pending_ingestions") {
        const count = this.db.pendingRows.filter((row) =>
          row.url === this.filters.url &&
          row.doc_type === this.filters.doc_type &&
          (!this.statusIn || this.statusIn.includes(row.status))
        ).length;
        resolve({ count, error: null });
        return;
      }
    }

    if (this.mode === "insert" && this.table === "pending_ingestions") {
      if (!this.insertPayload) throw new Error("Missing insert payload");
      this.db.pendingRows.push(
        structuredClone(this.insertPayload) as unknown as PendingRow,
      );
      resolve({ error: null });
      return;
    }

    throw new Error(`Unsupported then() for ${this.table}`);
  }
}

function fetcher(pages: Record<string, string>, onFetch?: () => void) {
  return (url: string): Promise<PageFetchResult> => {
    onFetch?.();
    const html = pages[url];
    return Promise.resolve(
      html === undefined
        ? { ok: false, status: 404, html: "" }
        : { ok: true, status: 200, html },
    );
  };
}

Deno.test("budget committee backfill pauses on deadline and resumes from saved queue", async () => {
  const db = new FakeDb();
  let ms = 0;
  let id = 0;
  const pages = {
    "https://www.fairfaxcounty.gov/budget/budget-committee-meetings": `
      <a href="/budget/board-supervisors-budget-committee-meeting-january-01-2023">2023</a>
      <a href="/budget/board-supervisors-budget-committee-meeting-january-01-2022">2022</a>
      <a href="/budget/board-supervisors-budget-committee-meeting-january-01-2021">2021</a>
      <a href="/budget/board-supervisors-budget-committee-meeting-january-01-2024">2024</a>
      <a href="/taxes/global-nav">Global nav under budget but out of source archive</a>
    `,
    "https://www.fairfaxcounty.gov/budget/board-supervisors-budget-committee-meeting-january-01-2023":
      `
      <a href="/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2023/jan-01/Agenda.pdf">Agenda</a>
    `,
    "https://www.fairfaxcounty.gov/budget/board-supervisors-budget-committee-meeting-january-01-2022":
      `
      <a href="/budget/sites/budget/files/Assets/Documents/budget%20committee%20meeting/2022/jan-01/Minutes.pdf">Minutes</a>
    `,
    "https://www.fairfaxcounty.gov/budget/board-supervisors-budget-committee-meeting-january-01-2021":
      `
      <a href="/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2021/jan-01/Presentation.pdf">Presentation</a>
    `,
  };

  const first = await runBudgetCommitteeBackfill(
    {
      db: db as unknown as BackfillDb,
      source: SOURCE,
      fetchPage: fetcher(pages, () => ms += 10),
    },
    {
      deadlineMs: 25,
      deadlineBufferMs: 0,
      requestDelayMs: 0,
      nowMs: () => ms,
      nowIso: () => "2026-07-08T00:00:00.000Z",
      newId: () =>
        `00000000-0000-7000-8000-${(++id).toString().padStart(12, "0")}`,
    },
  );

  assertEquals(first.status, "in_progress");
  assertEquals(first.reason, "soft_deadline");
  assertEquals(first.pages_fetched_this_run, 3);
  assertEquals(first.pending_ingestions_created_this_run, 2);
  assertEquals(first.queue_remaining, 1);
  assertEquals(db.pendingRows.length, 2);

  const storedRun = db.runs.get(
    "budget_committee_meeting_historical_2008_2023",
  );
  assert(storedRun, "expected persisted backfill run row");
  const state = storedRun.resume_state as BackfillResumeState;
  assert(
    !state.visited_urls.includes(
      "https://www.fairfaxcounty.gov/budget/board-supervisors-budget-committee-meeting-january-01-2024",
    ),
    "2024+ meeting pages must not be queued by the historical backfill",
  );
  assert(
    !state.visited_urls.includes(
      "https://www.fairfaxcounty.gov/taxes/global-nav",
    ),
    "non-budget-prefix nav links must stay out of the queue",
  );

  const second = await runBudgetCommitteeBackfill(
    {
      db: db as unknown as BackfillDb,
      source: SOURCE,
      fetchPage: fetcher(pages, () => ms += 10),
    },
    {
      deadlineMs: 100,
      deadlineBufferMs: 0,
      requestDelayMs: 0,
      nowMs: () => ms,
      nowIso: () => "2026-07-08T00:01:00.000Z",
      newId: () =>
        `00000000-0000-7000-8000-${(++id).toString().padStart(12, "0")}`,
    },
  );

  assertEquals(second.status, "complete");
  assertEquals(second.reason, "queue_drained");
  assertEquals(second.pending_ingestions_created_this_run, 1);
  assertEquals(
    db.pendingRows.length,
    3,
    "resume must not duplicate already-created rows",
  );
});

Deno.test("budget committee backfill is idempotent against active pending and current documents", async () => {
  const db = new FakeDb();
  db.currentDocuments.add(
    "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2023/may-01/Current.pdf",
  );
  db.pendingRows.push({
    id: "existing",
    url:
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/Documents/budget%20committee%20meeting/2022/may-01/Pending.pdf",
    doc_type: "bos_minutes",
    status: "pending",
  });

  const pages = {
    "https://www.fairfaxcounty.gov/budget/budget-committee-meetings": `
      <a href="/budget/board-supervisors-budget-committee-meeting-may-01-2023">2023</a>
      <a href="/budget/board-supervisors-budget-committee-meeting-may-01-2022">2022</a>
    `,
    "https://www.fairfaxcounty.gov/budget/board-supervisors-budget-committee-meeting-may-01-2023":
      `
      <a href="/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2023/may-01/Current.pdf">Current</a>
    `,
    "https://www.fairfaxcounty.gov/budget/board-supervisors-budget-committee-meeting-may-01-2022":
      `
      <a href="/budget/sites/budget/files/Assets/Documents/budget%20committee%20meeting/2022/may-01/Pending.pdf">Pending</a>
      <a href="/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2022/may-01/New.pdf">New</a>
    `,
  };

  const result = await runBudgetCommitteeBackfill(
    {
      db: db as unknown as BackfillDb,
      source: SOURCE,
      fetchPage: fetcher(pages),
    },
    {
      requestDelayMs: 0,
      nowIso: () => "2026-07-08T00:00:00.000Z",
      newId: () => "00000000-0000-7000-8000-000000000001",
    },
  );

  assertEquals(result.status, "complete");
  assertEquals(result.candidate_urls_seen_this_run, 3);
  assertEquals(result.current_documents_skipped_this_run, 1);
  assertEquals(result.active_ingestions_skipped_this_run, 1);
  assertEquals(result.pending_ingestions_created_this_run, 1);
  assertEquals(db.pendingRows.length, 2);
});
