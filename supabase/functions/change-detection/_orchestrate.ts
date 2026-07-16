/**
 * change-detection invocation orchestration — pulled out of index.ts (which
 * has a top-level Deno.serve() and so isn't importable from a test) so the
 * per-invocation shape can be unit tested with fake db/fetch dependencies.
 *
 * Per invocation:
 *   1. Discovery-source loop: work discovery sources (bos_summary,
 *      bos_minutes, budget_committee_meeting, budget_pdf_advertised,
 *      budget_pdf_adopted) in least-recently-invoked-first order, claiming
 *      each via _crawl_state.ts's lease before touching its checkpoint, for
 *      as long as the discovery-phase deadline allows. Any source(s) not
 *      reached this tick get picked up first the next tick (fairness
 *      rotation via last_invoked_at ordering) instead of the loop always
 *      restarting from the same config-order source.
 *   2. UNCONDITIONALLY — regardless of how step 1 exited (deadline reached
 *      partway through, all sources leased by a concurrent invocation, or
 *      finished early) — check Municode, check EnCode zoning, and sweep for
 *      stale documents. This ordering is deliberate: PR #93/#94 shipped a
 *      real production incident where an ancillary step running before the
 *      main loop threw and skipped regular work for that tick; the
 *      equivalent failure mode here would be the discovery loop's
 *      deadline-driven partial progress silently starving Municode/
 *      reconciliation/staleness on some invocations. See
 *      _orchestrate_test.ts's starvation-regression test.
 *
 * Each of Municode/EnCode also goes through the same claimSource() lease as
 * the discovery sources (guardrail: two invocations must never work the same
 * source's checkpoint at once) and EnCode additionally enforces its own
 * minimum-check-interval independent of whatever cadence the discovery
 * sources run at (see checkEncodeZoning below).
 */

import { generate as uuidv7 } from "@std/uuid/v7";
import {
  type AlertDetails,
  type AlertsDb,
  writeDedupedPendingAlert,
} from "../_shared/alerts.ts";
import { createPendingIngestionIfAbsent } from "../_shared/pending-ingestion.ts";
import {
  claimSource,
  type CrawlCycleResult,
  type CrawlStateDb,
  type DbError,
  type DocumentsSelectChain,
  listCrawlStates,
  persistCrawlState,
  runDiscoverySourceCycle,
} from "./_crawl_state.ts";
import {
  type ApiSource,
  apiSourcesOf,
  discoverySourcesOf,
  type PageFetcher,
  type SeedConfig,
} from "./_discovery.ts";
import type { HashFetcher, HeadFetcher } from "./_crawl_state.ts";

const DEFAULT_TOTAL_DEADLINE_MS = 120_000;
const DEFAULT_RESERVED_TAIL_MS = 20_000;
const DEFAULT_STALE_DOCUMENT_DAYS = 14;
const DEFAULT_ENCODE_ZONING_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — its old, pre-tightening cadence
const PLACEHOLDER_PREFIX = "REPLACE_WITH_";

export class UnknownSourceError extends Error {
  constructor(sourceId: string) {
    super(`Unknown discovery source id: ${sourceId}`);
  }
}

interface ReconciliationLogsResult {
  data: { supplement_job_id: string | number | null } | null;
  error: DbError | null;
}

interface ReconciliationLogsChain {
  order(column: string, opts: { ascending: boolean }): ReconciliationLogsChain;
  limit(n: number): ReconciliationLogsChain;
  maybeSingle(): PromiseLike<ReconciliationLogsResult>;
}

export type OrchestrateDb = CrawlStateDb & AlertsDb & {
  from(table: "code_reconciliation_logs"): {
    select(columns: string): ReconciliationLogsChain;
  };
};

export interface OrchestrateDeps {
  db: OrchestrateDb;
  config: SeedConfig;
  fetchPage: PageFetcher;
  fetchHead: HeadFetcher;
  fetchHash: HashFetcher;
  /** GET + JSON-parse, used for Municode's /Jobs/latest endpoint. */
  fetchJson: (url: string) => Promise<unknown>;
  triggerReconciliation: (
    jobId: string,
    pendingIngestionId: string,
  ) => Promise<boolean>;
  isEncodeZoningEnabled: () => boolean;
}

export interface OrchestrateOptions {
  requestedSourceId?: string | null;
  totalDeadlineMs?: number;
  reservedTailMs?: number;
  leaseMinutes?: number;
  encodeZoningMinIntervalMs?: number;
  staleDocumentDays?: number;
  alertCooldownMs?: number;
  nowMs?: () => number;
  nowIso?: () => string;
  newId?: () => string;
}

interface CommonOptions {
  leaseMinutes?: number;
  alertCooldownMs?: number;
  nowMs: () => number;
  nowIso: () => string;
  newId: () => string;
}

export interface SourceCycleSummary {
  sourceId: string;
  outcome: "completed" | "checkpointed" | "leased";
  result: CrawlCycleResult | null;
}

export interface MunicodeCheckSummary {
  checked: boolean;
  skipped_reason: "leased" | null;
  job_id: string | null;
  previous_job_id: string | null;
  pending_ingestion_id: string | null;
  reconciliation_triggered: boolean;
}

export interface EncodeZoningCheckSummary {
  checked: boolean;
  skipped_reason: "disabled" | "leased" | "min_interval" | null;
  pending_ingestion_id: string | null;
}

export interface ChangeDetectionResult {
  discovery: {
    sources_attempted: number;
    sources_leased: number;
    sources: SourceCycleSummary[];
  };
  municode: MunicodeCheckSummary;
  encode_zoning: EncodeZoningCheckSummary;
  stale_documents_found: number;
  stale_alerts_created: number;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlaceholderPattern(pattern: string): boolean {
  return pattern.trim().startsWith(PLACEHOLDER_PREFIX);
}

function toAbsoluteUrl(baseUrl: string, pattern: string): string {
  if (/^https?:\/\//i.test(pattern)) return new URL(pattern).toString();
  return new URL(pattern, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
    .toString();
}

function municodeSource(config: SeedConfig): ApiSource {
  const source = apiSourcesOf(config).find((s) =>
    s.doc_type === "municode_api"
  );
  if (!source) throw new Error("seed-sources.json missing municode_api source");
  return source;
}

function municodeLatestJobUrl(config: SeedConfig): string {
  const source = municodeSource(config);
  const latestPattern = source.url_patterns.find((p) =>
    p.includes("/Jobs/latest/")
  );
  if (!latestPattern || isPlaceholderPattern(latestPattern)) {
    throw new Error("seed-sources.json missing Municode /Jobs/latest seed URL");
  }
  return toAbsoluteUrl(source.base_url, latestPattern);
}

function extractMunicodeJobId(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new Error("Municode latest job response must be an object");
  }
  for (const key of ["jobId", "Id", "id"]) {
    const value = payload[key];
    if (value != null) return String(value);
  }
  throw new Error("Municode latest job response missing jobId/Id");
}

function encodeZoningSource(config: SeedConfig): ApiSource {
  const source = apiSourcesOf(config).find((s) =>
    s.doc_type === "encode_zoning"
  );
  if (!source) {
    throw new Error("seed-sources.json missing encode_zoning source");
  }
  return source;
}

async function latestReconciledMunicodeJobId(
  db: OrchestrateDb,
): Promise<string | null> {
  const { data, error: lookupErr } = await db
    .from("code_reconciliation_logs")
    .select("supplement_job_id, created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lookupErr) {
    throw new Error(
      `CodeReconciliationLog lookup failed: ${lookupErr.message}`,
    );
  }
  return data?.supplement_job_id ? String(data.supplement_job_id) : null;
}

/**
 * Checks Municode's /Jobs/latest for a new supplement job id, same lease
 * protection as the discovery sources (source_id 'municode_api'). Unlike
 * EnCode, this has no minimum-interval guard: it's a single lightweight
 * public-API GET with no compliance sensitivity, and must run every
 * invocation regardless of cadence (guardrail: Municode/reconciliation must
 * not get starved).
 */
async function checkMunicodeSupplement(
  deps: OrchestrateDeps,
  options: CommonOptions,
): Promise<MunicodeCheckSummary> {
  const claimed = await claimSource(deps.db, "municode_api", options);
  if (!claimed) {
    return {
      checked: false,
      skipped_reason: "leased",
      job_id: null,
      previous_job_id: null,
      pending_ingestion_id: null,
      reconciliation_triggered: false,
    };
  }

  try {
    const url = municodeLatestJobUrl(deps.config);
    const jobId = extractMunicodeJobId(await deps.fetchJson(url));
    const previousJobId = await latestReconciledMunicodeJobId(deps.db);

    if (previousJobId === jobId) {
      await persistCrawlState(deps.db, "municode_api", {
        claim_expires_at: null,
        last_checked_at: options.nowIso(),
      });
      return {
        checked: true,
        skipped_reason: null,
        job_id: jobId,
        previous_job_id: previousJobId,
        pending_ingestion_id: null,
        reconciliation_triggered: false,
      };
    }

    const pendingId = await createPendingIngestionIfAbsent(deps.db, {
      id: options.newId(),
      url,
      docType: "municode_api",
      nowIso: options.nowIso(),
    });
    const triggered = pendingId
      ? await deps.triggerReconciliation(jobId, pendingId)
      : false;

    await persistCrawlState(deps.db, "municode_api", {
      claim_expires_at: null,
      last_checked_at: options.nowIso(),
    });

    return {
      checked: true,
      skipped_reason: null,
      job_id: jobId,
      previous_job_id: previousJobId,
      pending_ingestion_id: pendingId,
      reconciliation_triggered: triggered,
    };
  } catch (e) {
    await persistCrawlState(deps.db, "municode_api", {
      claim_expires_at: null,
      last_error: (e as Error).message,
    });
    throw e;
  }
}

/**
 * Ensures exactly one active pending_ingestion exists for the EnCode zoning
 * ordinance, gated by:
 *   1. ENCODE_ZONING_ENABLED — mirrors handleEncode()'s own compliance gate
 *      (encode.ts) so a fresh pending_ingestion isn't created every
 *      invocation while the source is disabled pending legal sign-off.
 *   2. The same claimSource() lease every other source uses, so two
 *      overlapping invocations can't both fire this simultaneously.
 *   3. encodeZoningMinIntervalMs — an explicit minimum-interval guard
 *      independent of the discovery sources' cadence. EnCode's robots.txt
 *      disallows /regs/ for generic bots; the 6-hour default here preserves
 *      the same "one check per ~6h" frequency the whole function used to run
 *      at, even after the discovery sources move to a tighter cadence, so
 *      tightening the crawl for the other 5 sources can't silently multiply
 *      EnCode fetch frequency too.
 *
 * Unlike checkMunicodeSupplement, this does not itself fetch a version
 * signal before creating the pending row: EnCode has no lightweight
 * check separate from the Amendment History Table fetch encode.ts's
 * handleEncode() already makes to do its own dedup — duplicating that fetch
 * here would just double the request count against a robots.txt-disallowed
 * path for no benefit. handleEncode() marks the ingestion 'skipped' cheaply
 * when nothing has changed.
 */
async function checkEncodeZoning(
  deps: OrchestrateDeps,
  options: CommonOptions & { encodeZoningMinIntervalMs: number },
): Promise<EncodeZoningCheckSummary> {
  if (!deps.isEncodeZoningEnabled()) {
    return {
      checked: false,
      skipped_reason: "disabled",
      pending_ingestion_id: null,
    };
  }

  const claimed = await claimSource(deps.db, "encode_zoning", options);
  if (!claimed) {
    return {
      checked: false,
      skipped_reason: "leased",
      pending_ingestion_id: null,
    };
  }

  if (
    claimed.last_checked_at &&
    options.nowMs() - Date.parse(claimed.last_checked_at) <
      options.encodeZoningMinIntervalMs
  ) {
    await persistCrawlState(deps.db, "encode_zoning", {
      claim_expires_at: null,
    });
    return {
      checked: false,
      skipped_reason: "min_interval",
      pending_ingestion_id: null,
    };
  }

  try {
    const source = encodeZoningSource(deps.config);
    const canonicalUrl = `${source.base_url}/doc-viewer.aspx?secid=2214`;
    const pendingId = await createPendingIngestionIfAbsent(deps.db, {
      id: options.newId(),
      url: canonicalUrl,
      docType: "encode_zoning",
      nowIso: options.nowIso(),
    });

    await persistCrawlState(deps.db, "encode_zoning", {
      claim_expires_at: null,
      last_checked_at: options.nowIso(),
    });

    return {
      checked: true,
      skipped_reason: null,
      pending_ingestion_id: pendingId,
    };
  } catch (e) {
    await persistCrawlState(deps.db, "encode_zoning", {
      claim_expires_at: null,
      last_error: (e as Error).message,
    });
    throw e;
  }
}

async function writeStalenessAlerts(
  db: OrchestrateDb,
  staleDocumentDays: number,
  options: CommonOptions,
): Promise<{ found: number; written: number }> {
  const threshold = new Date(
    options.nowMs() - staleDocumentDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const staleChain: DocumentsSelectChain = db
    .from("documents")
    .select("id, url, doc_type, last_checked_at")
    .eq("status", "current");
  const { data, error: staleErr } = await staleChain.lt(
    "last_checked_at",
    threshold,
  );

  if (staleErr) {
    throw new Error(`Stale document lookup failed: ${staleErr.message}`);
  }
  if (!data || data.length === 0) return { found: 0, written: 0 };

  let written = 0;
  for (const doc of data) {
    const wasWritten = await writeDedupedPendingAlert(
      db,
      {
        reason: "document_stale",
        alert_key: doc.url,
        document_id: doc.id,
        url: doc.url,
        doc_type: doc.doc_type,
        last_checked_at: doc.last_checked_at,
        stale_after_days: staleDocumentDays,
      },
      {
        cooldownMs: options.alertCooldownMs,
        nowMs: options.nowMs,
        nowIso: options.nowIso,
        newId: options.newId,
      },
    );
    if (wasWritten) written += 1;
  }

  return { found: data.length, written };
}

async function reportSourceError(
  db: OrchestrateDb,
  reason: string,
  alertKey: string,
  details: Record<string, unknown>,
  options: CommonOptions,
): Promise<void> {
  const fullDetails: AlertDetails = { reason, alert_key: alertKey, ...details };
  await writeDedupedPendingAlert(db, fullDetails, {
    cooldownMs: options.alertCooldownMs,
    nowMs: options.nowMs,
    nowIso: options.nowIso,
    newId: options.newId,
  });
}

export async function runChangeDetectionCycle(
  deps: OrchestrateDeps,
  options: OrchestrateOptions = {},
): Promise<ChangeDetectionResult> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => uuidv7());
  const leaseMinutes = options.leaseMinutes;
  const totalDeadlineMs = options.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS;
  const reservedTailMs = options.reservedTailMs ?? DEFAULT_RESERVED_TAIL_MS;
  const encodeZoningMinIntervalMs = options.encodeZoningMinIntervalMs ??
    DEFAULT_ENCODE_ZONING_MIN_INTERVAL_MS;
  const staleDocumentDays = options.staleDocumentDays ??
    DEFAULT_STALE_DOCUMENT_DAYS;
  const alertCooldownMs = options.alertCooldownMs;
  const commonOptions: CommonOptions = {
    leaseMinutes,
    alertCooldownMs,
    nowMs,
    nowIso,
    newId,
  };

  const runStart = nowMs();
  const discoveryDeadline = runStart +
    Math.max(0, totalDeadlineMs - reservedTailMs);

  const allDiscoverySources = discoverySourcesOf(deps.config);
  if (options.requestedSourceId) {
    if (!allDiscoverySources.some((s) => s.id === options.requestedSourceId)) {
      throw new UnknownSourceError(options.requestedSourceId);
    }
  }
  const eligibleSourceIds = new Set(
    (options.requestedSourceId
      ? allDiscoverySources.filter((s) => s.id === options.requestedSourceId)
      : allDiscoverySources).map((s) => s.id),
  );

  const orderedStates = (await listCrawlStates(deps.db)).filter((row) =>
    eligibleSourceIds.has(row.source_id)
  );

  const sourceSummaries: SourceCycleSummary[] = [];
  const errors: string[] = [];

  // ── Phase 1: discovery sources, deadline-bounded ──────────────────────────
  for (const row of orderedStates) {
    if (nowMs() >= discoveryDeadline) break;

    const source = allDiscoverySources.find((s) => s.id === row.source_id)!;
    // claimSource() itself (not just runDiscoverySourceCycle) must be inside
    // this try: an uncaught throw here -- e.g. a transient DB error -- would
    // otherwise propagate out of this whole function and skip Phase 2 for
    // the invocation, the exact PR #93/#94 starvation shape this loop's
    // unconditional-Phase-2 ordering exists to prevent. See
    // _orchestrate_test.ts's starvation-regression test.
    let claimed: Awaited<ReturnType<typeof claimSource>> = null;
    try {
      claimed = await claimSource(deps.db, row.source_id, {
        leaseMinutes,
        nowMs,
        nowIso,
      });
      if (!claimed) {
        sourceSummaries.push({
          sourceId: row.source_id,
          outcome: "leased",
          result: null,
        });
        continue;
      }

      const result = await runDiscoverySourceCycle(
        {
          db: deps.db,
          source,
          allSources: allDiscoverySources,
          fetchPage: deps.fetchPage,
          fetchHead: deps.fetchHead,
          fetchHash: deps.fetchHash,
        },
        claimed,
        { deadlineMs: discoveryDeadline, nowMs, nowIso, newId },
      );

      sourceSummaries.push({
        sourceId: row.source_id,
        outcome: result.cycleCompleted ? "completed" : "checkpointed",
        result,
      });

      for (const err of result.errorsThisRun) {
        errors.push(`${err.url}: ${err.message}`);
        await reportSourceError(
          deps.db,
          "change_detection_source_error",
          err.url,
          {
            doc_type: source.doc_type,
            source_id: source.id,
            message: err.message,
          },
          commonOptions,
        );
      }
    } catch (e) {
      const message = (e as Error).message;
      errors.push(`${row.source_id}: ${message}`);
      // Only release/record on the source's own row if a lease was actually
      // claimed -- if claimSource() itself is what threw, there is no lease
      // to release, and retrying the same write here would just throw again
      // for the same reason. Both recovery steps get their own try/catch so
      // a failure handling the failure still can't escape this loop and
      // starve Phase 2.
      if (claimed) {
        try {
          await persistCrawlState(deps.db, row.source_id, {
            claim_expires_at: null,
            last_error: message,
          });
        } catch (persistErr) {
          errors.push(
            `${row.source_id}: failed to release lease after error: ${
              (persistErr as Error).message
            }`,
          );
        }
      }
      try {
        await reportSourceError(
          deps.db,
          "change_detection_source_error",
          row.source_id,
          { doc_type: source.doc_type, source_id: source.id, message },
          commonOptions,
        );
      } catch (alertErr) {
        errors.push(
          `${row.source_id}: failed to record source error alert: ${
            (alertErr as Error).message
          }`,
        );
      }
    }
  }

  // ── Phase 2: UNCONDITIONAL every invocation, regardless of Phase 1's outcome ─
  let municode: MunicodeCheckSummary = {
    checked: false,
    skipped_reason: null,
    job_id: null,
    previous_job_id: null,
    pending_ingestion_id: null,
    reconciliation_triggered: false,
  };
  try {
    municode = await checkMunicodeSupplement(deps, commonOptions);
  } catch (e) {
    const message = (e as Error).message;
    errors.push(`municode_api: ${message}`);
    await reportSourceError(
      deps.db,
      "change_detection_municode_error",
      "municode_api",
      { doc_type: "municode_api", message },
      commonOptions,
    );
  }

  let encodeZoning: EncodeZoningCheckSummary = {
    checked: false,
    skipped_reason: null,
    pending_ingestion_id: null,
  };
  try {
    encodeZoning = await checkEncodeZoning(deps, {
      ...commonOptions,
      encodeZoningMinIntervalMs,
    });
  } catch (e) {
    const message = (e as Error).message;
    errors.push(`encode_zoning: ${message}`);
    await reportSourceError(
      deps.db,
      "change_detection_encode_zoning_error",
      "encode_zoning",
      { doc_type: "encode_zoning", message },
      commonOptions,
    );
  }

  let staleness = { found: 0, written: 0 };
  try {
    staleness = await writeStalenessAlerts(
      deps.db,
      staleDocumentDays,
      commonOptions,
    );
  } catch (e) {
    errors.push(`staleness_sweep: ${(e as Error).message}`);
  }

  return {
    discovery: {
      sources_attempted: sourceSummaries.length,
      sources_leased:
        sourceSummaries.filter((s) => s.outcome === "leased").length,
      sources: sourceSummaries,
    },
    municode,
    encode_zoning: encodeZoning,
    stale_documents_found: staleness.found,
    stale_alerts_created: staleness.written,
    errors,
  };
}
