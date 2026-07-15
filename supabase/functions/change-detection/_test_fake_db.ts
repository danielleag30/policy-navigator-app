/**
 * In-memory fake implementing OrchestrateDb (a superset of CrawlStateDb) for
 * _crawl_state_test.ts and _orchestrate_test.ts. Mirrors the real
 * discovery_crawl_state/documents/pending_ingestions/pending_alerts/
 * code_reconciliation_logs tables' relevant columns and the exact
 * PostgREST-style filter shapes _crawl_state.ts, _shared/alerts.ts, and
 * _shared/pending-ingestion.ts issue against them (see each's source for the
 * literal chains being mimicked here) -- not a general-purpose PostgREST mock.
 *
 * claimSource()'s lease check is parsed directly out of the `.or(...)`
 * filter string it builds (`claim_expires_at.is.null,claim_expires_at.lt.<iso>`)
 * rather than read from a wall-clock now(), so tests can inject nowIso/nowMs
 * and get fully deterministic lease-expiry behavior.
 */

import type { CrawlStateRow } from "./_crawl_state.ts";

export interface FakeDocumentRow {
  id: string;
  url: string;
  doc_type: string;
  status: string;
  content_hash: string;
  last_checked_at: string;
}

export interface FakeAlertRow {
  id: string;
  reason: string;
  alert_key: string;
  triggered_at: string;
}

export interface FakeReconciliationLogRow {
  supplement_job_id: string | number | null;
  created_at: string;
}

interface DbError {
  code?: string;
  message: string;
}

function parseOrThreshold(condition: string): string | null {
  const part = condition.split(",").find((p) => p.startsWith("claim_expires_at.lt."));
  return part ? part.slice("claim_expires_at.lt.".length) : null;
}

class CrawlStateUpdateChain {
  #sourceId: string | null = null;
  #requireUnclaimedBefore: string | null = null;

  constructor(
    private table: Map<string, CrawlStateRow>,
    private payload: Record<string, unknown>,
    /** One-shot per-source_id failure injection — see FakeOrchestrateDb.failNextUpdateFor. */
    private failNextUpdateFor: Map<string, string>,
  ) {}

  eq(_column: "source_id", value: string): this {
    this.#sourceId = value;
    return this;
  }

  or(condition: string): this {
    this.#requireUnclaimedBefore = parseOrThreshold(condition);
    return this;
  }

  select(_columns: string) {
    return {
      maybeSingle: (): Promise<{ data: CrawlStateRow | null; error: DbError | null }> => {
        if (!this.#sourceId) throw new Error("fake: missing .eq(source_id)");

        const injectedMessage = this.failNextUpdateFor.get(this.#sourceId);
        if (injectedMessage !== undefined) {
          this.failNextUpdateFor.delete(this.#sourceId);
          return Promise.resolve({ data: null, error: { message: injectedMessage } });
        }

        const row = this.table.get(this.#sourceId);
        if (!row) return Promise.resolve({ data: null, error: null });

        if (this.#requireUnclaimedBefore !== null) {
          const leased = row.claim_expires_at !== null &&
            Date.parse(row.claim_expires_at) >= Date.parse(this.#requireUnclaimedBefore);
          if (leased) return Promise.resolve({ data: null, error: null });
        }

        const updated = { ...row, ...this.payload } as CrawlStateRow;
        this.table.set(this.#sourceId, updated);
        return Promise.resolve({ data: updated, error: null });
      },
    };
  }
}

class CrawlStateListChain {
  constructor(private table: Map<string, CrawlStateRow>) {}

  order(
    _column: "last_invoked_at",
    opts: { ascending: boolean },
  ): Promise<{ data: CrawlStateRow[] | null; error: DbError | null }> {
    const rows = Array.from(this.table.values());
    rows.sort((a, b) => {
      const cmp = Date.parse(a.last_invoked_at) - Date.parse(b.last_invoked_at);
      return opts.ascending ? cmp : -cmp;
    });
    return Promise.resolve({ data: rows, error: null });
  }
}

class DocumentsSelectChain {
  #filters: Record<string, string> = {};

  constructor(private docs: Map<string, FakeDocumentRow>) {}

  eq(column: string, value: string): this {
    this.#filters[column] = value;
    return this;
  }

  #matching(): FakeDocumentRow[] {
    return Array.from(this.docs.values()).filter((d) =>
      Object.entries(this.#filters).every(
        ([k, v]) => (d as unknown as Record<string, unknown>)[k] === v,
      )
    );
  }

  lt(
    column: string,
    value: string,
  ): Promise<{ data: FakeDocumentRow[] | null; error: DbError | null }> {
    const rows = this.#matching().filter((d) =>
      (d as unknown as Record<string, string>)[column] < value
    );
    return Promise.resolve({ data: rows, error: null });
  }

  maybeSingle(): Promise<{ data: FakeDocumentRow | null; error: DbError | null }> {
    return Promise.resolve({ data: this.#matching()[0] ?? null, error: null });
  }
}

class DocumentsUpdateChain {
  constructor(
    private docs: Map<string, FakeDocumentRow>,
    private payload: Record<string, unknown>,
  ) {}

  eq(_column: string, value: string): Promise<{ error: DbError | null }> {
    const doc = this.docs.get(value);
    if (doc) Object.assign(doc, this.payload);
    return Promise.resolve({ error: null });
  }
}

class PendingIngestionsTable {
  constructor(
    private rows: Map<string, Record<string, unknown>>,
    private activeKeys: Set<string>,
  ) {}

  insert(
    payload: { id: string; url: string; doc_type: string; status: string },
  ): Promise<{ error: DbError | null }> {
    const key = `${payload.url}::${payload.doc_type}`;
    if (this.activeKeys.has(key)) {
      return Promise.resolve({
        error: { code: "23505", message: "duplicate key value violates unique constraint" },
      });
    }
    this.activeKeys.add(key);
    this.rows.set(payload.id, payload);
    return Promise.resolve({ error: null });
  }
}

class AlertsSelectQuery implements PromiseLike<{ data: { triggered_at: string } | null; error: DbError | null }> {
  #filters: Record<string, string> = {};

  constructor(private alerts: FakeAlertRow[]) {}

  eq(column: string, value: string): this {
    this.#filters[column] = value;
    return this;
  }

  order(_column: string, _opts: { ascending: boolean }): this {
    return this;
  }

  limit(_n: number): this {
    return this;
  }

  maybeSingle(): Promise<{ data: { triggered_at: string } | null; error: DbError | null }> {
    const matches = this.alerts
      .filter((a) =>
        (this.#filters["details->>reason"] === undefined ||
          a.reason === this.#filters["details->>reason"]) &&
        (this.#filters["details->>alert_key"] === undefined ||
          a.alert_key === this.#filters["details->>alert_key"])
      )
      .sort((a, b) => Date.parse(b.triggered_at) - Date.parse(a.triggered_at));
    return Promise.resolve({
      data: matches[0] ? { triggered_at: matches[0].triggered_at } : null,
      error: null,
    });
  }

  // deno-lint-ignore no-explicit-any
  then<TResult1 = { data: { triggered_at: string } | null; error: DbError | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: { triggered_at: string } | null; error: DbError | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.maybeSingle().then(onfulfilled, onrejected);
  }
}

class PendingAlertsTable {
  constructor(private alerts: FakeAlertRow[]) {}

  select(_columns: string): AlertsSelectQuery {
    return new AlertsSelectQuery(this.alerts);
  }

  insert(
    payload: { id: string; details: { reason: string; alert_key: string }; triggered_at: string },
  ): Promise<{ error: DbError | null }> {
    this.alerts.push({
      id: payload.id,
      reason: payload.details.reason,
      alert_key: payload.details.alert_key,
      triggered_at: payload.triggered_at,
    });
    return Promise.resolve({ error: null });
  }
}

class ReconciliationLogsChain {
  constructor(private rows: FakeReconciliationLogRow[]) {}

  order(_column: string, _opts: { ascending: boolean }): this {
    return this;
  }

  limit(_n: number): this {
    return this;
  }

  maybeSingle(): Promise<
    { data: { supplement_job_id: string | number | null } | null; error: DbError | null }
  > {
    const sorted = [...this.rows].sort((a, b) =>
      Date.parse(b.created_at) - Date.parse(a.created_at)
    );
    return Promise.resolve({
      data: sorted[0] ? { supplement_job_id: sorted[0].supplement_job_id } : null,
      error: null,
    });
  }
}

/**
 * Structurally satisfies OrchestrateDb (and therefore CrawlStateDb, which
 * OrchestrateDb intersects). Seed data is mutated in place by the functions
 * under test, exactly like a real backing table would be.
 */
export class FakeOrchestrateDb {
  crawlState = new Map<string, CrawlStateRow>();
  documents = new Map<string, FakeDocumentRow>();
  pendingIngestions = new Map<string, Record<string, unknown>>();
  #activePendingIngestionKeys = new Set<string>();
  alerts: FakeAlertRow[] = [];
  reconciliationLogs: FakeReconciliationLogRow[] = [];
  /**
   * source_id -> error message. The *next* discovery_crawl_state update
   * call for that source_id (claimSource or persistCrawlState) fails with
   * this message, then the entry is consumed -- for simulating a real,
   * unexpected DB failure mid-cycle (as opposed to a fetch/scan error,
   * which the code under test already handles without throwing).
   */
  failNextUpdateFor = new Map<string, string>();

  seedCrawlState(rows: CrawlStateRow[]): this {
    for (const row of rows) this.crawlState.set(row.source_id, row);
    return this;
  }

  seedDocuments(rows: FakeDocumentRow[]): this {
    for (const row of rows) this.documents.set(row.id, row);
    return this;
  }

  // Deliberately a single non-overloaded signature rather than per-table
  // overloads: TypeScript's overload-set assignability check compares
  // overloads positionally, not by matching each target signature against
  // any compatible source signature, and is unreliable once the return
  // types get this deep. Callers cast this (db as unknown as OrchestrateDb /
  // CrawlStateDb) the same way index.ts casts the real SupabaseClient --
  // this fake's per-table behavior below is still exercised (and type
  // checked internally) by every test that calls through it.
  // deno-lint-ignore no-explicit-any
  from(table: string): any {
    switch (table) {
      case "discovery_crawl_state":
        return {
          update: (payload: Record<string, unknown>) =>
            new CrawlStateUpdateChain(this.crawlState, payload, this.failNextUpdateFor),
          select: (_columns: string) => new CrawlStateListChain(this.crawlState),
        };
      case "documents":
        return {
          select: (_columns: string) => new DocumentsSelectChain(this.documents),
          update: (payload: Record<string, unknown>) => new DocumentsUpdateChain(this.documents, payload),
        };
      case "pending_ingestions":
        return new PendingIngestionsTable(this.pendingIngestions, this.#activePendingIngestionKeys);
      case "pending_alerts":
        return new PendingAlertsTable(this.alerts);
      case "code_reconciliation_logs":
        return { select: (_columns: string) => new ReconciliationLogsChain(this.reconciliationLogs) };
      default:
        throw new Error(`fake: unhandled table ${table}`);
    }
  }
}

export function crawlStateRow(overrides: Partial<CrawlStateRow> & { source_id: string; doc_type: CrawlStateRow["doc_type"] }): CrawlStateRow {
  return {
    status: "idle",
    resume_state: {},
    claim_expires_at: null,
    cycle_started_at: null,
    last_cycle_completed_at: null,
    last_checked_at: null,
    cycles_completed: 0,
    pages_fetched: 0,
    candidate_urls_seen: 0,
    pending_ingestions_created: 0,
    active_ingestions_skipped: 0,
    last_checked_updates: 0,
    errors: [],
    last_invoked_at: "2026-01-01T00:00:00.000Z",
    last_error: null,
    ...overrides,
  };
}
