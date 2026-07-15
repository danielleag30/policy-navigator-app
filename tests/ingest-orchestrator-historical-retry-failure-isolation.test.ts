/**
 * Regression test for a production incident (2026-07-15): the normal
 * cron-poll path in index.ts calls handleMunicodeHistoricalEmbeddingRetry()
 * unconditionally, before the regular pending_ingestions loop runs. When
 * that call threw -- in production, because
 * supabase/migrations/20260713000000_historical_embedding_retry_queue.sql
 * shipped in the same PR (#93) as this call site but was never applied to
 * the live project, so the query referenced columns that did not exist --
 * the catch block returned a fast HTTP 500 for the *entire* invocation,
 * aborting the regular pending_ingestions loop below it for that cron tick
 * too, even though that loop has nothing to do with historical embeddings.
 *
 * Fix: this ancillary, best-effort backlog-drain step must not be able to
 * take down the higher-priority regular ingestion loop. Log the failure and
 * fall through, mirroring the same "don't let historical-retry work starve
 * regular ingestion" principle the adjacent !complete guard already applies
 * on the success path (see
 * ingest-orchestrator-historical-retry-fallthrough.test.ts).
 *
 * Like that sibling test, this reads the live guard/catch text directly out
 * of the real orchestrator source (not a hand-copied reimplementation that
 * could silently drift from the real fix), matching the convention already
 * established in this file for testing index.ts's top-level control flow
 * without a live Supabase instance.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const INDEX_SRC_PATH = new URL(
  "../supabase/functions/ingest-orchestrator/index.ts",
  import.meta.url,
).pathname;

async function extractHistoricalRetryCatchBody(): Promise<string> {
  const src = await Deno.readTextFile(INDEX_SRC_PATH);
  const anchor =
    "await handleMunicodeHistoricalEmbeddingRetry(SOFT_DEADLINE_MS);";
  const anchorIdx = src.indexOf(anchor);
  assert(
    anchorIdx !== -1,
    "handleMunicodeHistoricalEmbeddingRetry call site not found",
  );

  const catchMarker = "} catch (e) {";
  const catchIdx = src.indexOf(catchMarker, anchorIdx);
  assert(catchIdx !== -1, "catch block after the retry call not found");

  // Brace-count from the catch body's opening `{` to find its matching close,
  // since the body itself may contain nested braces (template literals, etc).
  const bodyStart = catchIdx + catchMarker.length - 1;
  let depth = 0;
  let i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  assert(depth === 0, "unbalanced braces while scanning the catch block");

  return src.slice(bodyStart, i + 1);
}

Deno.test(
  "historical embedding retry catch block does not return early -- must fall through to the regular pending_ingestions loop",
  async () => {
    const catchBody = await extractHistoricalRetryCatchBody();

    assert(
      !/\breturn\b/.test(catchBody),
      `historical embedding retry catch block must not return (a return here ` +
        `would 500 the whole invocation and skip regular ingestion for the ` +
        `cron tick) -- found a return statement:\n${catchBody}`,
    );
  },
);

Deno.test(
  "historical embedding retry catch block still logs the failure for observability",
  async () => {
    const catchBody = await extractHistoricalRetryCatchBody();

    assert(
      /console\.error/.test(catchBody),
      "historical embedding retry catch block should still log the failure even though it no longer aborts the invocation",
    );
  },
);
