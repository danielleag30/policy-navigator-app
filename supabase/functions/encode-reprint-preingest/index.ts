/**
 * encode-reprint-preingest — resumable OCR pre-ingestion for the 18 EnCode
 * historical zoning-ordinance reprints.
 *
 * Invoked by pg_cron (see the accompanying cron migration) and callable
 * directly (POST { deadline_ms? }) for a targeted/manual run. All real logic
 * lives in _preingest.ts's runEncodeReprintPreingest, which has no top-level
 * Deno.serve() so it can be exercised directly by _preingest_test.ts with
 * fake dependencies — this file owns only the HTTP-request-shaped concerns
 * (deadline computation, response envelope, request logging).
 *
 * SOFT_DEADLINE_MS mirrors ingest-orchestrator's own convention: well under
 * the platform's ~150s hard kill, so a checkpoint always has time to persist
 * before the invocation is killed outright.
 */

// deno-lint-ignore no-import-prefix no-unversioned-import
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import db from "../_shared/db-client.ts";
import { error, success } from "../_shared/response.ts";
import { elapsed, logError, logInfo } from "../_shared/logger.ts";
import {
  buildFetchOcrChunk,
  buildFetchPageCount,
  type EncodeReprintDb,
  runEncodeReprintPreingest,
} from "./_preingest.ts";

const FN_NAME = "encode-reprint-preingest";
const DEFAULT_SOFT_DEADLINE_MS = 120_000; // well under ~150s hard kill

Deno.serve(async (req: Request) => {
  const runStart = Date.now();
  if (req.method !== "POST") {
    return error(
      "INGESTION_FAILED",
      "Use POST to run the pre-ingestion job",
      405,
    );
  }

  try {
    let body: { deadline_ms?: number; pages_per_chunk?: number } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const doclingUrl = Deno.env.get("HF_SPACES_DOCLING_URL");
    if (!doclingUrl) {
      logError(FN_NAME, "HF_SPACES_DOCLING_URL not set");
      return error("INGESTION_FAILED", "HF_SPACES_DOCLING_URL not set", 500);
    }

    const deadlineMs = runStart +
      (body.deadline_ms ?? DEFAULT_SOFT_DEADLINE_MS);

    const result = await runEncodeReprintPreingest(
      {
        db: db as unknown as EncodeReprintDb,
        fetchPageCount: buildFetchPageCount(doclingUrl),
        fetchOcrChunk: buildFetchOcrChunk(doclingUrl),
      },
      {
        deadlineMs,
        pagesPerChunk: body.pages_per_chunk,
      },
    );

    logInfo(FN_NAME, "invocation complete", {
      reason: result.reason,
      reprints_touched: result.processedReprints.length,
      elapsed_ms: elapsed(runStart),
    });
    return success(result);
  } catch (e) {
    logError(FN_NAME, "fatal error", { message: (e as Error).message });
    return error(
      "INGESTION_FAILED",
      "Encode reprint pre-ingestion failed",
      500,
    );
  }
});
