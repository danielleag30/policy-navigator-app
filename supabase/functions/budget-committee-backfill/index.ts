// deno-lint-ignore no-import-prefix no-unversioned-import
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import db from "../_shared/db-client.ts";
import { error, success } from "../_shared/response.ts";
import { elapsed, logError, logInfo } from "../_shared/logger.ts";
import seedConfig from "../../config/seed-sources.json" with { type: "json" };
import {
  discoverySourcesOf,
  type PageFetchResult,
  validateSeedConfig,
} from "../change-detection/_discovery.ts";
import { type BackfillDb, runBudgetCommitteeBackfill } from "./_backfill.ts";

const FN_NAME = "budget-committee-backfill";
const DEFAULT_USER_AGENT = "PolicyNavigator/1.0 budget-committee-backfill";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FairfaxRateLimiter {
  private nextAllowedAt = 0;
  private chain: Promise<void> = Promise.resolve();

  wait(): Promise<void> {
    const run = this.chain.then(async () => {
      const now = Date.now();
      if (now < this.nextAllowedAt) await sleep(this.nextAllowedAt - now);
      this.nextAllowedAt = Date.now() + 200;
    });
    this.chain = run.catch(() => {});
    return run;
  }
}

function userAgent(): string {
  return Deno.env.get("FAIRFAX_USER_AGENT") ?? DEFAULT_USER_AGENT;
}

function buildPageFetcher(limiter: FairfaxRateLimiter) {
  return async (url: string): Promise<PageFetchResult> => {
    await limiter.wait();
    const resp = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": userAgent() },
    });
    return {
      ok: resp.ok,
      status: resp.status,
      html: resp.ok ? await resp.text() : "",
    };
  };
}

Deno.serve(async (req: Request) => {
  const runStart = Date.now();
  if (req.method !== "POST") {
    return error("INGESTION_FAILED", "Use POST to run the backfill", 405);
  }

  try {
    const config = validateSeedConfig(seedConfig);
    const source = discoverySourcesOf(config).find((s) =>
      s.id === "budget_committee_meeting"
    );
    if (!source) {
      return error(
        "NOT_FOUND",
        "budget_committee_meeting source not found",
        404,
      );
    }

    let body: {
      deadline_ms?: number;
      min_year?: number;
      max_year?: number;
      run_id?: string;
    } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const result = await runBudgetCommitteeBackfill(
      {
        db: db as unknown as BackfillDb,
        source: {
          ...source,
          discovery_follow_min_year: body.min_year ?? 2008,
        },
        fetchPage: buildPageFetcher(new FairfaxRateLimiter()),
      },
      {
        runId: body.run_id,
        deadlineMs: body.deadline_ms,
        minYear: body.min_year,
        maxYear: body.max_year,
      },
    );

    logInfo(FN_NAME, "backfill invocation complete", {
      status: result.status,
      reason: result.reason,
      pages_fetched_this_run: result.pages_fetched_this_run,
      pending_ingestions_created_this_run:
        result.pending_ingestions_created_this_run,
      queue_remaining: result.queue_remaining,
      elapsed_ms: elapsed(runStart),
    });
    return success(result);
  } catch (e) {
    logError(FN_NAME, "fatal error", { message: (e as Error).message });
    return error("INGESTION_FAILED", "Budget committee backfill failed", 500);
  }
});
