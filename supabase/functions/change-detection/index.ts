/**
 * change-detection — scheduled source freshness scanner.
 *
 * Invoked by pg_cron every 6 hours (cron registration is task 2-16).
 * Reads supabase/config/seed-sources.json. Discovery sources (bos_summary,
 * bos_minutes, budget_pdf) are crawled via _discovery.ts — starting from each
 * source's discovery_urls and following same-hostname links up to
 * discovery_depth hops — to find candidate document URLs, which are then
 * scanned exactly like any other seed URL. The municode_api source is not
 * crawled; it keeps its own base_url/url_patterns lookup.
 */

// deno-lint-ignore no-unversioned-import
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { contentHash } from "../_shared/hash.ts";
import { error, success } from "../_shared/response.ts";
import { elapsed, logError, logInfo, logWarn } from "../_shared/logger.ts";
import seedConfig from "../../config/seed-sources.json" with { type: "json" };
import {
  type ApiSource,
  apiSourcesOf,
  discoverAllCandidates,
  type DiscoveredUrl,
  discoverySourcesOf,
  type DocType,
  type PageFetchResult,
  type SeedConfig,
  validateSeedConfig,
} from "./_discovery.ts";

const FN_NAME = "change-detection";

interface CurrentDocument {
  id: string;
  url: string;
  doc_type: DocType;
  content_hash: string;
  last_checked_at: string;
}

interface UrlScanResult {
  url: string;
  doc_type: DocType;
  action:
    | "pending_ingestion_created"
    | "active_ingestion_exists"
    | "last_checked_updated"
    | "error";
  pending_ingestion_id?: string;
  document_id?: string;
  message?: string;
}

interface ChangeDetectionSummary {
  scanned_urls: number;
  pending_ingestions_created: number;
  active_ingestions_skipped: number;
  last_checked_updates: number;
  stale_alerts_created: number;
  discovery: {
    sources_crawled: number;
    candidate_urls_found: number;
    crawl_errors: number;
  };
  municode: {
    checked: boolean;
    job_id: string | null;
    previous_job_id: string | null;
    pending_ingestion_id: string | null;
    reconciliation_triggered: boolean;
  };
  errors: string[];
  results: UrlScanResult[];
}

const FAIRFAX_REQUEST_DELAY_MS = 200;
const STALE_DOCUMENT_DAYS = 14;
const DEFAULT_USER_AGENT = "PolicyNavigator/1.0 change-detection";
const PLACEHOLDER_PREFIX = "REPLACE_WITH_";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isFairfaxCountyUrl(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === "fairfaxcounty.gov" ||
    hostname.endsWith(".fairfaxcounty.gov");
}

/**
 * Shared 200ms-between-requests limiter for every fairfaxcounty.gov call this
 * function makes — HEAD-based change checks and discovery-page GETs alike —
 * so both request kinds count against the same budget instead of stacking.
 */
class FairfaxRateLimiter {
  #lastRequestStartedAt = 0;

  async waitIfNeeded(url: string): Promise<void> {
    if (!isFairfaxCountyUrl(url)) return;

    const elapsedMs = Date.now() - this.#lastRequestStartedAt;
    if (
      this.#lastRequestStartedAt > 0 && elapsedMs < FAIRFAX_REQUEST_DELAY_MS
    ) {
      await sleep(FAIRFAX_REQUEST_DELAY_MS - elapsedMs);
    }
    this.#lastRequestStartedAt = Date.now();
  }
}

function userAgent(): string {
  return Deno.env.get("CHANGE_DETECTION_USER_AGENT") ??
    Deno.env.get("MUNICODE_USER_AGENT") ??
    DEFAULT_USER_AGENT;
}

/**
 * Builds a discovery PageFetcher backed by the shared rate limiter, memoized
 * per URL so sources that share a discovery_urls root (e.g. bos_summary and
 * bos_minutes both start at board-meeting-information) fetch it once per run.
 */
function buildPageFetcher(
  limiter: FairfaxRateLimiter,
): (url: string) => Promise<PageFetchResult> {
  const cache = new Map<string, Promise<PageFetchResult>>();

  return (url: string) => {
    let cached = cache.get(url);
    if (!cached) {
      cached = fetchDiscoveryPage(url, limiter);
      cache.set(url, cached);
    }
    return cached;
  };
}

async function fetchDiscoveryPage(
  url: string,
  limiter: FairfaxRateLimiter,
): Promise<PageFetchResult> {
  await limiter.waitIfNeeded(url);
  const resp = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": userAgent() },
  });
  return {
    ok: resp.ok,
    status: resp.status,
    html: resp.ok ? await resp.text() : "",
  };
}

async function getCurrentDocument(
  url: string,
): Promise<CurrentDocument | null> {
  const { data, error: lookupErr } = await db
    .from("documents")
    .select("id, url, doc_type, content_hash, last_checked_at")
    .eq("url", url)
    .eq("status", "current")
    .maybeSingle();

  if (lookupErr) {
    throw new Error(`Document lookup failed for ${url}: ${lookupErr.message}`);
  }
  return data as CurrentDocument | null;
}

async function hasActivePendingIngestion(
  url: string,
  docType: DocType,
): Promise<boolean> {
  const { count, error: lookupErr } = await db
    .from("pending_ingestions")
    .select("id", { count: "exact", head: true })
    .eq("url", url)
    .eq("doc_type", docType)
    .in("status", ["pending", "processing"]);

  if (lookupErr) {
    throw new Error(
      `PendingIngestion lookup failed for ${url}: ${lookupErr.message}`,
    );
  }
  return (count ?? 0) > 0;
}

async function createPendingIngestion(
  url: string,
  docType: DocType,
): Promise<string | null> {
  if (await hasActivePendingIngestion(url, docType)) return null;

  const id = uuidv7();
  const { error: insertErr } = await db.from("pending_ingestions").insert({
    id,
    url,
    doc_type: docType,
    detected_at: new Date().toISOString(),
    status: "pending",
  });

  if (insertErr) {
    throw new Error(
      `PendingIngestion insert failed for ${url}: ${insertErr.message}`,
    );
  }

  return id;
}

async function updateLastChecked(documentId: string): Promise<void> {
  const { error: updateErr } = await db
    .from("documents")
    .update({ last_checked_at: new Date().toISOString() })
    .eq("id", documentId);

  if (updateErr) {
    throw new Error(
      `Document last_checked_at update failed for ${documentId}: ${updateErr.message}`,
    );
  }
}

function normalizedValidator(value: string): string {
  return value.trim().replace(/^W\//i, "").replace(/^"|"$/g, "").toLowerCase();
}

function headMatchesStoredHash(headers: Headers, storedHash: string): boolean {
  const etag = headers.get("etag");
  if (!etag) return false;

  const lastModified = headers.get("last-modified");
  const stored = normalizedValidator(storedHash);

  return [etag, lastModified]
    .filter((v): v is string => Boolean(v))
    .some((v) => normalizedValidator(v) === stored);
}

async function fetchHead(
  url: string,
  limiter: FairfaxRateLimiter,
): Promise<Response> {
  await limiter.waitIfNeeded(url);
  return fetch(url, {
    method: "HEAD",
    redirect: "follow",
    headers: { "User-Agent": userAgent() },
  });
}

async function fetchHash(url: string): Promise<string> {
  const resp = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": userAgent() },
  });
  if (!resp.ok) {
    throw new Error(`GET ${url} returned HTTP ${resp.status}`);
  }
  return contentHash(new Uint8Array(await resp.arrayBuffer()));
}

async function scanSeedUrl(
  seedUrl: DiscoveredUrl,
  limiter: FairfaxRateLimiter,
): Promise<UrlScanResult> {
  const current = await getCurrentDocument(seedUrl.url);
  const headResp = await fetchHead(seedUrl.url, limiter);

  if (!headResp.ok && headResp.status !== 405) {
    throw new Error(`HEAD ${seedUrl.url} returned HTTP ${headResp.status}`);
  }

  if (
    current && headResp.ok &&
    headMatchesStoredHash(headResp.headers, current.content_hash)
  ) {
    await updateLastChecked(current.id);
    return {
      url: seedUrl.url,
      doc_type: seedUrl.docType,
      action: "last_checked_updated",
      document_id: current.id,
      message: "remote validator matched stored content_hash",
    };
  }

  const hash = await fetchHash(seedUrl.url);
  if (current && hash === current.content_hash) {
    await updateLastChecked(current.id);
    return {
      url: seedUrl.url,
      doc_type: seedUrl.docType,
      action: "last_checked_updated",
      document_id: current.id,
      message: "content hash unchanged",
    };
  }

  const pendingId = await createPendingIngestion(seedUrl.url, seedUrl.docType);
  if (!pendingId) {
    return {
      url: seedUrl.url,
      doc_type: seedUrl.docType,
      action: "active_ingestion_exists",
      document_id: current?.id,
    };
  }

  return {
    url: seedUrl.url,
    doc_type: seedUrl.docType,
    action: "pending_ingestion_created",
    pending_ingestion_id: pendingId,
    document_id: current?.id,
  };
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

async function latestReconciledMunicodeJobId(): Promise<string | null> {
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

async function triggerReconciliation(
  jobId: string,
  pendingIngestionId: string,
): Promise<boolean> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return false;

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/reconciliation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        supplement_job_id: jobId,
        pending_ingestion_id: pendingIngestionId,
      }),
    });
    return resp.ok;
  } catch (e) {
    logWarn(FN_NAME, "reconciliation trigger failed", {
      message: (e as Error).message,
    });
    return false;
  }
}

async function checkMunicodeSupplement(
  config: SeedConfig,
): Promise<ChangeDetectionSummary["municode"]> {
  const url = municodeLatestJobUrl(config);
  const resp = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": userAgent() },
  });
  if (!resp.ok) {
    throw new Error(`Municode latest job GET returned HTTP ${resp.status}`);
  }

  const jobId = extractMunicodeJobId(await resp.json());
  const previousJobId = await latestReconciledMunicodeJobId();

  if (previousJobId === jobId) {
    return {
      checked: true,
      job_id: jobId,
      previous_job_id: previousJobId,
      pending_ingestion_id: null,
      reconciliation_triggered: false,
    };
  }

  const pendingId = await createPendingIngestion(url, "municode_api");
  const triggered = pendingId
    ? await triggerReconciliation(jobId, pendingId)
    : false;

  return {
    checked: true,
    job_id: jobId,
    previous_job_id: previousJobId,
    pending_ingestion_id: pendingId,
    reconciliation_triggered: triggered,
  };
}

async function writePendingAlert(
  details: Record<string, unknown>,
): Promise<void> {
  const { error: alertErr } = await db.from("pending_alerts").insert({
    id: uuidv7(),
    alert_type: "ingestion_failure",
    details,
    triggered_at: new Date().toISOString(),
  });

  if (alertErr) {
    throw new Error(`PendingAlert insert failed: ${alertErr.message}`);
  }
}

async function writeStalenessAlerts(): Promise<number> {
  const threshold = new Date(
    Date.now() - STALE_DOCUMENT_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data, error: staleErr } = await db
    .from("documents")
    .select("id, url, doc_type, last_checked_at")
    .eq("status", "current")
    .lt("last_checked_at", threshold);

  if (staleErr) {
    throw new Error(`Stale document lookup failed: ${staleErr.message}`);
  }
  if (!data || data.length === 0) return 0;

  for (const doc of data) {
    await writePendingAlert({
      reason: "document_stale",
      document_id: doc.id,
      url: doc.url,
      doc_type: doc.doc_type,
      last_checked_at: doc.last_checked_at,
      stale_after_days: STALE_DOCUMENT_DAYS,
    });
  }

  return data.length;
}

function summarizeResults(
  results: UrlScanResult[],
  staleAlertsCreated: number,
  discovery: ChangeDetectionSummary["discovery"],
  municode: ChangeDetectionSummary["municode"],
): ChangeDetectionSummary {
  return {
    scanned_urls: results.length,
    pending_ingestions_created:
      results.filter((r) => r.action === "pending_ingestion_created").length +
      (municode.pending_ingestion_id ? 1 : 0),
    active_ingestions_skipped:
      results.filter((r) => r.action === "active_ingestion_exists").length,
    last_checked_updates:
      results.filter((r) => r.action === "last_checked_updated").length,
    stale_alerts_created: staleAlertsCreated,
    discovery,
    municode,
    errors: results.filter((r) => r.action === "error").map((r) =>
      `${r.url}: ${r.message}`
    ),
    results,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return error("NOT_FOUND", "Method not allowed", 405);
  }

  const runStart = Date.now();

  try {
    const config = validateSeedConfig(seedConfig);
    const discoverySources = discoverySourcesOf(config);
    const limiter = new FairfaxRateLimiter();
    const fetchPage = buildPageFetcher(limiter);

    const { candidates, errors: crawlErrors } = await discoverAllCandidates(
      discoverySources,
      fetchPage,
    );
    logInfo(FN_NAME, "discovery crawl complete", {
      sources_crawled: discoverySources.length,
      candidate_urls_found: candidates.length,
      crawl_errors: crawlErrors.length,
      elapsed_ms: elapsed(runStart),
    });

    const results: UrlScanResult[] = [];

    for (const crawlErr of crawlErrors) {
      results.push({
        url: crawlErr.url,
        doc_type: crawlErr.docType,
        action: "error",
        message: crawlErr.message,
      });
      await writePendingAlert({
        reason: "change_detection_discovery_error",
        url: crawlErr.url,
        source_id: crawlErr.sourceId,
        doc_type: crawlErr.docType,
        message: crawlErr.message,
      });
    }

    for (const candidate of candidates) {
      try {
        results.push(await scanSeedUrl(candidate, limiter));
      } catch (e) {
        const message = (e as Error).message;
        logError(FN_NAME, "URL scan failed", { url: candidate.url, message });
        results.push({
          url: candidate.url,
          doc_type: candidate.docType,
          action: "error",
          message,
        });
        await writePendingAlert({
          reason: "change_detection_source_error",
          url: candidate.url,
          doc_type: candidate.docType,
          message,
        });
      }
    }

    let municode: ChangeDetectionSummary["municode"] = {
      checked: false,
      job_id: null,
      previous_job_id: null,
      pending_ingestion_id: null,
      reconciliation_triggered: false,
    };

    try {
      municode = await checkMunicodeSupplement(config);
    } catch (e) {
      const message = (e as Error).message;
      logError(FN_NAME, "Municode check failed", { message });
      results.push({
        url: "municode_api",
        doc_type: "municode_api",
        action: "error",
        message,
      });
      await writePendingAlert({
        reason: "change_detection_municode_error",
        doc_type: "municode_api",
        message,
      });
    }

    const staleAlertsCreated = await writeStalenessAlerts();
    const discovery = {
      sources_crawled: discoverySources.length,
      candidate_urls_found: candidates.length,
      crawl_errors: crawlErrors.length,
    };

    return success(
      summarizeResults(results, staleAlertsCreated, discovery, municode),
    );
  } catch (e) {
    logError(FN_NAME, "fatal error", { message: (e as Error).message });
    return error("INGESTION_FAILED", "Change detection failed", 500);
  }
});
