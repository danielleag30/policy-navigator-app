import type { DiscoverySource } from "../change-detection/_discovery.ts";
import { type BackfillDb, type BackfillRunRow, runBudgetCommitteeBackfill } from "./_backfill.ts";

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

interface DbError {
  code?: string;
  message: string;
}

interface DbSingleResult<T> {
  data: T | null;
  error: DbError | null;
}

interface DbCountResult {
  count: number | null;
  error: DbError | null;
}

interface DbMutationResult {
  error: DbError | null;
}

const SOURCE: DiscoverySource = {
  id: "budget_committee_meeting",
  doc_type: "bos_minutes",
  discovery_urls: [
    "https://www.fairfaxcounty.gov/budget/budget-committee-meetings",
  ],
  discovery_depth: 1,
  allow_patterns: [
    "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/Documents/budget%20committee%20meeting/",
  ],
};

const PDF_URL =
  "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/Documents/budget%20committee%20meeting/FY-2023-Budget-Committee.pdf";

class RunSelectById {
  constructor(private db: FakeBackfillDb) {}

  maybeSingle(): Promise<DbSingleResult<BackfillRunRow>> {
    return Promise.resolve({ data: this.db.run, error: null });
  }
}

class RunSelectQuery {
  constructor(private db: FakeBackfillDb) {}

  eq(_column: "id", _value: string): RunSelectById {
    return new RunSelectById(this.db);
  }
}

class RunInsertQuery {
  constructor(private db: FakeBackfillDb, private row: BackfillRunRow) {}

  select(
    _columns: string,
  ): { single: () => Promise<DbSingleResult<BackfillRunRow>> } {
    return {
      single: () => {
        this.db.run = structuredClone(this.row);
        return Promise.resolve({ data: this.db.run, error: null });
      },
    };
  }
}

class RunUpdateById {
  constructor(
    private db: FakeBackfillDb,
    private payload: Partial<BackfillRunRow>,
  ) {}

  select(
    _columns: string,
  ): { single: () => Promise<DbSingleResult<BackfillRunRow>> } {
    return {
      single: () => {
        this.db.run = { ...this.db.run!, ...this.payload };
        return Promise.resolve({ data: this.db.run, error: null });
      },
    };
  }
}

class RunUpdateQuery {
  constructor(
    private db: FakeBackfillDb,
    private payload: Partial<BackfillRunRow>,
  ) {}

  eq(_column: "id", _value: string): RunUpdateById {
    return new RunUpdateById(this.db, this.payload);
  }
}

class DiscoveryBackfillRunsTable {
  constructor(private db: FakeBackfillDb) {}

  select(_columns: string): RunSelectQuery {
    return new RunSelectQuery(this.db);
  }

  insert(payload: Record<string, unknown>): RunInsertQuery {
    return new RunInsertQuery(this.db, payload as unknown as BackfillRunRow);
  }

  update(payload: Record<string, unknown>): RunUpdateQuery {
    return new RunUpdateQuery(this.db, payload as Partial<BackfillRunRow>);
  }
}

class DocumentsCountQuery implements PromiseLike<DbCountResult> {
  #filters: Record<string, unknown> = {};

  constructor(private currentDocumentUrls: Set<string>) {}

  eq(column: string, value: unknown): this {
    this.#filters[column] = value;
    return this;
  }

  then<TResult1 = DbCountResult, TResult2 = never>(
    onfulfilled?:
      | ((value: DbCountResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const url = String(this.#filters.url ?? "");
    return Promise.resolve({
      count: this.currentDocumentUrls.has(url) ? 1 : 0,
      error: null,
    }).then(onfulfilled, onrejected);
  }
}

class DocumentsTable {
  constructor(private currentDocumentUrls: Set<string>) {}

  select(
    _columns: string,
    _opts: { count: "exact"; head: true },
  ): DocumentsCountQuery {
    return new DocumentsCountQuery(this.currentDocumentUrls);
  }
}

class PendingIngestionsTable {
  constructor(private db: FakeBackfillDb) {}

  insert(_payload: {
    id: string;
    url: string;
    doc_type: string;
    detected_at: string;
    status: "pending";
  }): Promise<DbMutationResult> {
    this.db.pendingInsertCalls += 1;
    return Promise.resolve({
      error: {
        code: "23505",
        message: "duplicate key value violates unique constraint",
      },
    });
  }
}

class FakeBackfillDb {
  run: BackfillRunRow | null = null;
  pendingInsertCalls = 0;
  currentDocumentUrls = new Set<string>();

  from(table: string) {
    if (table === "discovery_backfill_runs") {
      return new DiscoveryBackfillRunsTable(this);
    }
    if (table === "documents") {
      return new DocumentsTable(this.currentDocumentUrls);
    }
    if (table === "pending_ingestions") {
      return new PendingIngestionsTable(this);
    }
    throw new Error(`Unexpected table: ${table}`);
  }
}

Deno.test("budget backfill treats duplicate pending_ingestion insert as an active skip", async () => {
  const db = new FakeBackfillDb();

  const result = await runBudgetCommitteeBackfill(
    {
      db: db as unknown as BackfillDb,
      source: SOURCE,
      fetchPage: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          html: `<a href="${PDF_URL}">FY 2024 Budget Committee</a>`,
        }),
    },
    {
      runId: "test-run",
      requestDelayMs: 0,
      minYear: 2008,
      maxYear: 2023,
      nowMs: () => 0,
      nowIso: () => "2026-07-15T00:00:00.000Z",
      newId: () => "018f4d8a-8a46-7c46-9c46-2a9f688f1d3a",
    },
  );

  assertEquals(db.pendingInsertCalls, 1);
  assertEquals(result.pending_ingestions_created_this_run, 0);
  assertEquals(result.active_ingestions_skipped_this_run, 1);
  assertEquals(result.totals.pending_ingestions_created, 0);
  assertEquals(result.totals.active_ingestions_skipped, 1);
});
