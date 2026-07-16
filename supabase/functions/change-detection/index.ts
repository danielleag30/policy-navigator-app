/**
 * change-detection — scheduled source freshness scanner.
 *
 * Invoked by pg_cron every 6 hours (cron registration is task 2-16).
 * Reads supabase/config/seed-sources.json and delegates the actual work to
 * _orchestrate.ts's runChangeDetectionCycle: discovery sources (bos_summary,
 * bos_minutes, budget_committee_meeting, budget_pdf_advertised,
 * budget_pdf_adopted) are crawled via _crawl_state.ts's resumable, per-source
 * checkpointed cycle -- each invocation picks up exactly where the last one
 * (this one, if there's time left, or the next cron tick) left off, rather
 * than losing all progress at this platform's ~150s IDLE_TIMEOUT the way the
 * old single-pass BFS crawl did. municode_api and encode_zoning are not
 * crawled; they keep their own base_url/url_patterns lookup, unconditionally
 * checked every invocation regardless of the discovery loop's outcome (see
 * _orchestrate.ts's file header for why that ordering matters).
 *
 * POST ?source=<id> restricts discovery crawling to one source id (see
 * supabase/config/seed-sources.json) for a cheaper, targeted run; municode_api,
 * encode_zoning, and the staleness sweep still run every invocation regardless.
 *
 * This file owns only the HTTP-request-shaped concerns (rate limiting real
 * network fetches, request parsing, response envelope) that don't belong in
 * the pure/testable _orchestrate.ts, which has no top-level Deno.serve() so
 * it can be exercised directly by _orchestrate_test.ts with fake dependencies.
 */

// deno-lint-ignore no-import-prefix no-unversioned-import
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import db from "../_shared/db-client.ts";
import { contentHash } from "../_shared/hash.ts";
import { error, success } from "../_shared/response.ts";
import { elapsed, logError, logInfo, logWarn } from "../_shared/logger.ts";
import seedConfig from "../../config/seed-sources.json" with { type: "json" };
import {
  type PageFetchResult,
  type SeedConfig,
  validateSeedConfig,
} from "./_discovery.ts";
import type { HeadFetchResult } from "./_crawl_state.ts";
import {
  type OrchestrateDb,
  runChangeDetectionCycle,
  UnknownSourceError,
} from "./_orchestrate.ts";

const FN_NAME = "change-detection";

const FAIRFAX_REQUEST_DELAY_MS = 200;
const DEFAULT_USER_AGENT = "PolicyNavigator/1.0 change-detection";

function isFairfaxCountyUrl(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === "fairfaxcounty.gov" ||
    hostname.endsWith(".fairfaxcounty.gov");
}

/**
 * Shared 200ms-between-requests limiter for every fairfaxcounty.gov call this
 * function makes -- HEAD-based change checks and discovery-page GETs alike --
 * so both request kinds count against the same budget instead of stacking.
 *
 * Callers may invoke waitIfNeeded concurrently (the discovery crawler fetches
 * a whole BFS level at once so page round-trips overlap). A promise chain
 * serializes request *start* times ≥200ms apart regardless of caller
 * concurrency, without forcing each request's full completion to block the
 * next one's start the way a naive "check elapsed time" limiter would under
 * concurrent callers.
 */
class FairfaxRateLimiter {
  #chain: Promise<void> = Promise.resolve();
  #anyRequestStarted = false;

  waitIfNeeded(url: string): Promise<void> {
    if (!isFairfaxCountyUrl(url)) return Promise.resolve();

    const shouldDelay = this.#anyRequestStarted;
    this.#anyRequestStarted = true;
    this.#chain = this.#chain.then(() =>
      shouldDelay ? sleep(FAIRFAX_REQUEST_DELAY_MS) : undefined
    );
    return this.#chain;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function fetchHead(
  url: string,
  limiter: FairfaxRateLimiter,
): Promise<HeadFetchResult> {
  await limiter.waitIfNeeded(url);
  const resp = await fetch(url, {
    method: "HEAD",
    redirect: "follow",
    headers: { "User-Agent": userAgent() },
  });
  return {
    ok: resp.ok,
    status: resp.status,
    etag: resp.headers.get("etag"),
    lastModified: resp.headers.get("last-modified"),
  };
}

async function fetchHash(
  url: string,
  limiter: FairfaxRateLimiter,
): Promise<string> {
  await limiter.waitIfNeeded(url);
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

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": userAgent() },
  });
  if (!resp.ok) {
    throw new Error(`GET ${url} returned HTTP ${resp.status}`);
  }
  return await resp.json();
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

function isEncodeZoningEnabled(): boolean {
  return Deno.env.get("ENCODE_ZONING_ENABLED") === "true";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return error("NOT_FOUND", "Method not allowed", 405);
  }

  const runStart = Date.now();

  try {
    const config: SeedConfig = validateSeedConfig(seedConfig);
    const requestedSourceId = new URL(req.url).searchParams.get("source");
    const limiter = new FairfaxRateLimiter();
    const fetchPage = buildPageFetcher(limiter);

    const result = await runChangeDetectionCycle(
      {
        // db-client.ts's real SupabaseClient doesn't structurally satisfy
        // OrchestrateDb's narrow per-table interfaces (its query builder's
        // .then() resolves an unconstrained generic row type) -- same cast
        // pattern as budget-committee-backfill/index.ts's BackfillDb.
        db: db as unknown as OrchestrateDb,
        config,
        fetchPage,
        fetchHead: (url: string) => fetchHead(url, limiter),
        fetchHash: (url: string) => fetchHash(url, limiter),
        fetchJson,
        triggerReconciliation,
        isEncodeZoningEnabled,
      },
      { requestedSourceId },
    );

    logInfo(FN_NAME, "change detection cycle complete", {
      elapsed_ms: elapsed(runStart),
      sources_attempted: result.discovery.sources_attempted,
      sources_leased: result.discovery.sources_leased,
      municode_checked: result.municode.checked,
      encode_zoning_checked: result.encode_zoning.checked,
      stale_documents_found: result.stale_documents_found,
      stale_alerts_created: result.stale_alerts_created,
      error_count: result.errors.length,
    });

    return success(result);
  } catch (e) {
    if (e instanceof UnknownSourceError) {
      return error("NOT_FOUND", e.message, 404);
    }
    logError(FN_NAME, "fatal error", { message: (e as Error).message });
    return error("INGESTION_FAILED", "Change detection failed", 500);
  }
});
