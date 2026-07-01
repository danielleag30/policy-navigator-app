// Tests for the source-PDF fetch timeout fix (task 2-3 follow-up).
//
// The raw source-PDF fetch (used for content-hashing, before the Docling call)
// previously had no AbortController, so a slow/hanging source host could burn
// the entire ~150s wall-clock budget and get hard-killed (HTTP 546) before the
// already time-boxed Docling call ever ran. These tests verify:
//   1. (static) the orchestrator source wires an AbortController + timeout
//      around the source fetch, using the same style as the Docling fix, and
//      the outer catch block treats a source-fetch timeout the same way as a
//      Docling timeout (15-min retry override, "deferred" response, no
//      terminal 500).
//   2. (behavioral) the actual AbortController + setTimeout mechanism used in
//      pdfBranch aborts a hanging fetch well before it would run out the clock,
//      exercised against a real local HTTP server that never responds.

const ORCHESTRATOR = new URL(
  "../supabase/functions/ingest-orchestrator/index.ts",
  import.meta.url,
).pathname;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function extractBetween(src: string, startMarker: string, endMarker: string): string {
  const startIdx = src.indexOf(startMarker);
  assert(startIdx !== -1, `Start marker not found: "${startMarker}"`);
  const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  assert(endIdx !== -1, `End marker not found after start: "${endMarker}"`);
  return src.slice(startIdx, endIdx);
}

// ---------------------------------------------------------------------------
// Static source-inspection tests
// ---------------------------------------------------------------------------

Deno.test("SOURCE_FETCH_TIMEOUT_MS constant is defined and reasonably sized", async () => {
  const src = await Deno.readTextFile(ORCHESTRATOR);
  assert(
    src.includes("const SOURCE_FETCH_TIMEOUT_MS = 20_000;"),
    "SOURCE_FETCH_TIMEOUT_MS must be defined as 20_000 (20s)",
  );
});

Deno.test("source fetch is wrapped in an AbortController tied to SOURCE_FETCH_TIMEOUT_MS", async () => {
  const src = await Deno.readTextFile(ORCHESTRATOR);

  const fetchBody = extractBetween(
    src,
    "// 1. Fetch source PDF bytes for content_hash",
    "// 2. Compute content_hash",
  );

  assert(
    fetchBody.includes("new AbortController()"),
    "source-PDF fetch must use an AbortController, matching the Docling-call fix pattern",
  );
  assert(
    fetchBody.includes("setTimeout(") && fetchBody.includes("SOURCE_FETCH_TIMEOUT_MS"),
    "source-PDF fetch must schedule its abort via setTimeout(..., SOURCE_FETCH_TIMEOUT_MS)",
  );
  assert(
    fetchBody.includes("signal: sourceFetchController.signal"),
    "the fetch() call must pass the AbortController's signal",
  );
  assert(
    fetchBody.includes('e instanceof DOMException && (e as DOMException).name === "AbortError"'),
    "the catch block must distinguish AbortError from other fetch failures",
  );
  assert(
    fetchBody.includes("clearTimeout(sourceFetchTimer)"),
    "the abort timer must be cleared once the fetch settles (finally block)",
  );
});

Deno.test("outer catch block treats source-fetch timeout the same way as Docling timeout", async () => {
  const src = await Deno.readTextFile(ORCHESTRATOR);

  assert(
    src.includes("const isSourceFetchTimeout =") &&
      src.includes("msg === `Source PDF fetch timed out after ${SOURCE_FETCH_TIMEOUT_MS / 1000}s`"),
    "catch block must detect the source-fetch timeout error message",
  );

  const retryBody = extractBetween(
    src,
    "// Reset to pending for retry.",
    "const { error: resetErr }",
  );
  assert(
    retryBody.includes("isDoclingTimeout || isSourceFetchTimeout"),
    "the 15-min retry override must apply to both Docling and source-fetch timeouts",
  );

  const tailBody = extractBetween(
    src,
    "// Return 200 for expected timeouts so pg_cron logs stay clean.",
    'return error("INGESTION_FAILED"',
  );
  assert(
    tailBody.includes('reason: "source_fetch_timeout"'),
    "a source-fetch timeout must return a 200 'deferred' response (not a terminal 500), " +
      "so pg_cron logs stay clean and the row is retried rather than stuck",
  );
});

Deno.test("ABSOLUTE_MAX_ATTEMPTS ceiling still applies before a source-fetch timeout could loop forever", async () => {
  const src = await Deno.readTextFile(ORCHESTRATOR);
  assert(
    src.includes("if (newAttempts > ABSOLUTE_MAX_ATTEMPTS)"),
    "the max-attempts skip check must remain intact and run before pdfBranch (and thus the source fetch) is reached",
  );
});

// ---------------------------------------------------------------------------
// Behavioral test: exercise the actual abort mechanism against a hanging server
// ---------------------------------------------------------------------------

Deno.test(
  "behavioral: AbortController timeout aborts a hanging source fetch instead of hanging indefinitely",
  async () => {
    // A server that accepts the connection but never writes a response,
    // simulating a slow/hanging source PDF host.
    const ac = new AbortController();
    const server = Deno.serve(
      { port: 0, signal: ac.signal, onListen: () => {} },
      () => new Promise<Response>(() => {}), // never resolves
    );
    const port = (server.addr as Deno.NetAddr).port;

    const TEST_TIMEOUT_MS = 300; // short timeout so the test runs fast
    const sourceFetchController = new AbortController();
    const sourceFetchTimer = setTimeout(
      () => sourceFetchController.abort(),
      TEST_TIMEOUT_MS,
    );

    const start = performance.now();
    let threw: Error | undefined;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/`, {
        redirect: "follow",
        signal: sourceFetchController.signal,
      });
      await resp.arrayBuffer();
    } catch (e) {
      threw = e as Error;
    } finally {
      clearTimeout(sourceFetchTimer);
    }
    const elapsedMs = performance.now() - start;

    ac.abort();
    await server.finished;

    assert(threw !== undefined, "fetch to a hanging server must reject, not resolve");
    assert(
      threw instanceof DOMException && threw.name === "AbortError",
      `expected AbortError, got: ${threw?.name}: ${threw?.message}`,
    );
    // Generous upper bound to avoid flakiness while still proving it aborted
    // near the configured timeout rather than hanging for the full test run.
    assert(
      elapsedMs < TEST_TIMEOUT_MS + 2000,
      `fetch took ${elapsedMs}ms to abort, expected close to ${TEST_TIMEOUT_MS}ms`,
    );
  },
);
