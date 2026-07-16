/**
 * Deduped pending_alerts writer.
 *
 * writeStalenessAlerts() and change-detection's discovery/source/Municode/
 * EnCode error alerting previously wrote a fresh pending_alerts row on every
 * invocation that still observed the same condition -- e.g. the same stale
 * document, or the same discovery source erroring on the same URL. That was
 * tolerable at the old 6-hour cadence; a tightened recurring-crawl cadence
 * directly multiplies it into alert-fatigue noise for whoever triages
 * pending_alerts.
 *
 * details must include a `reason` (the alert's condition, e.g.
 * "document_stale") and an `alert_key` (the specific thing it's about --
 * a url, or a doc_type when there's no per-URL granularity, e.g. the
 * Municode/EnCode source-level checks). Before inserting, this looks up the
 * most recent alert sharing that exact (reason, alert_key) pair and skips
 * the write if one landed within the cooldown window -- the same condition
 * recurring seconds or minutes apart (every tick of a tight cadence) is
 * exactly the noise this exists to suppress; the same condition recurring
 * hours later is a genuinely new occurrence worth a fresh alert.
 */

const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // matches change-detection's pre-existing 6h cadence

interface DbError {
  message: string;
}

interface AlertRow {
  triggered_at: string;
}

interface MaybeSingleResult {
  data: AlertRow | null;
  error: DbError | null;
}

interface AlertsSelectQuery extends PromiseLike<MaybeSingleResult> {
  eq(column: string, value: string): AlertsSelectQuery;
  order(column: string, opts: { ascending: boolean }): AlertsSelectQuery;
  limit(n: number): AlertsSelectQuery;
  maybeSingle(): PromiseLike<MaybeSingleResult>;
}

interface InsertResult {
  error: DbError | null;
}

export interface PendingAlertsTable {
  select(columns: string): AlertsSelectQuery;
  insert(payload: Record<string, unknown>): PromiseLike<InsertResult>;
}

export interface AlertsDb {
  from(table: "pending_alerts"): PendingAlertsTable;
}

export interface AlertDetails extends Record<string, unknown> {
  reason: string;
  alert_key: string;
}

export interface WritePendingAlertOptions {
  cooldownMs?: number;
  nowMs?: () => number;
  nowIso?: () => string;
  newId?: () => string;
}

async function mostRecentAlertTriggeredAt(
  db: AlertsDb,
  reason: string,
  alertKey: string,
): Promise<string | null> {
  const { data, error: lookupErr } = await db
    .from("pending_alerts")
    .select("triggered_at")
    .eq("details->>reason", reason)
    .eq("details->>alert_key", alertKey)
    .order("triggered_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lookupErr) {
    throw new Error(`PendingAlert dedupe lookup failed: ${lookupErr.message}`);
  }
  return data?.triggered_at ?? null;
}

/**
 * Writes an 'ingestion_failure' pending_alerts row unless one with the same
 * (reason, alert_key) already landed within the cooldown window. Returns
 * whether a row was written.
 */
export async function writeDedupedPendingAlert(
  db: AlertsDb,
  details: AlertDetails,
  options: WritePendingAlertOptions = {},
): Promise<boolean> {
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const nowMs = options.nowMs ?? (() => Date.now());
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const newId = options.newId;
  if (!newId) {
    throw new Error("writeDedupedPendingAlert requires options.newId");
  }

  const lastTriggeredAt = await mostRecentAlertTriggeredAt(
    db,
    details.reason,
    details.alert_key,
  );
  if (lastTriggeredAt && nowMs() - Date.parse(lastTriggeredAt) < cooldownMs) {
    return false;
  }

  const { error: insertErr } = await db.from("pending_alerts").insert({
    id: newId(),
    alert_type: "ingestion_failure",
    details,
    triggered_at: nowIso(),
  });

  if (insertErr) {
    throw new Error(`PendingAlert insert failed: ${insertErr.message}`);
  }
  return true;
}
