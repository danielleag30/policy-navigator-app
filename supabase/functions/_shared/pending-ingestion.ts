/**
 * Atomic pending_ingestions creation, shared by every source that discovers
 * candidate URLs (change-detection's recurring crawl, its Municode/EnCode
 * checks, and budget-committee-backfill's one-time historical backfill).
 *
 * Previously each caller did its own SELECT (an active pending/processing
 * row for this url+doc_type?) followed by a separate INSERT. Two overlapping
 * invocations could both pass the SELECT before either committed its INSERT
 * -- a TOCTOU race with no uniqueness guard behind it. The partial unique
 * index pending_ingestions_active_url_doc_type_idx (migration
 * 20260715000000) turns the INSERT itself into the atomic conditional
 * write: this function just attempts the insert and treats a unique
 * violation (Postgres/PostgREST error code 23505) as "already active" --
 * the same "let a constraint make the write atomic" shape already proven by
 * ordinance_provisions_one_current_per_node_idx for municode.ts's
 * supersession logic, rather than a new one-off pattern.
 */

const UNIQUE_VIOLATION = "23505";

export interface PendingIngestionInsert {
  id: string;
  url: string;
  doc_type: string;
  budget_stage?: "advertised" | "adopted" | null;
  detected_at: string;
  status: "pending";
}

interface DbError {
  code?: string;
  message: string;
}

interface InsertResult {
  error: DbError | null;
}

export interface PendingIngestionsTable {
  insert(payload: PendingIngestionInsert): PromiseLike<InsertResult>;
}

export interface PendingIngestionDb {
  from(table: "pending_ingestions"): PendingIngestionsTable;
}

/**
 * Attempts to create a 'pending' pending_ingestions row for (url, doc_type).
 * Returns the new row's id, or null if an active (pending/processing) row
 * for the same (url, doc_type) already exists -- whether it existed before
 * this call or was created concurrently by a racing invocation.
 */
export async function createPendingIngestionIfAbsent(
  db: PendingIngestionDb,
  params: {
    id: string;
    url: string;
    docType: string;
    budgetStage?: "advertised" | "adopted" | null;
    nowIso: string;
  },
): Promise<string | null> {
  const { error: insertErr } = await db.from("pending_ingestions").insert({
    id: params.id,
    url: params.url,
    doc_type: params.docType,
    budget_stage: params.budgetStage ?? null,
    detected_at: params.nowIso,
    status: "pending",
  });

  if (!insertErr) return params.id;
  if (insertErr.code === UNIQUE_VIOLATION) return null;

  throw new Error(
    `PendingIngestion insert failed for ${params.url}: ${insertErr.message}`,
  );
}
