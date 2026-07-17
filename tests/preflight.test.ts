// Static code-inspection tests for task 2-20 (DAN-102): pre-flight AI Session check.
// All tests read the orchestrator source at rest — no live DB or Edge Function runtime needed.

const ORCHESTRATOR = new URL(
  "../supabase/functions/ingest-orchestrator/index.ts",
  import.meta.url,
).pathname;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Return the substring of `src` starting at `startMarker` (inclusive) and ending
 * just before `endMarker`, where the end search begins after the start position.
 */
function extractBetween(src: string, startMarker: string, endMarker: string): string {
  const startIdx = src.indexOf(startMarker);
  assert(startIdx !== -1, `Start marker not found: "${startMarker}"`);
  const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  assert(endIdx !== -1, `End marker not found after start: "${endMarker}"`);
  return src.slice(startIdx, endIdx);
}

Deno.test(
  "AC-1: preflight(session) call appears before PDF branch and Municode branch",
  async () => {
    const src = await Deno.readTextFile(ORCHESTRATOR);

    const preflightIdx = src.indexOf("const ready = await preflight(session)");
    const pdfBranchIdx = src.indexOf("if (isPdf) {");
    const municodeBranchIdx = src.indexOf("if (isMunicode) {");

    assert(preflightIdx !== -1, "preflight(session) call not found in orchestrator source");
    assert(pdfBranchIdx !== -1, "PDF branch (if (isPdf)) not found in orchestrator source");
    assert(
      municodeBranchIdx !== -1,
      "Municode branch (if (isMunicode)) not found in orchestrator source",
    );
    assert(
      preflightIdx < pdfBranchIdx,
      `preflight() must appear before PDF branch: preflight@${preflightIdx}, PDF branch@${pdfBranchIdx}`,
    );
    assert(
      preflightIdx < municodeBranchIdx,
      `preflight() must appear before Municode branch: preflight@${preflightIdx}, Municode@${municodeBranchIdx}`,
    );
  },
);

Deno.test(
  "AC-2: deferIngestion() sets status='pending', 15-min next_attempt_at, records deduped alert",
  async () => {
    const src = await Deno.readTextFile(ORCHESTRATOR);

    assert(
      src.includes("AI_SESSION_DEFER_MINUTES = 15"),
      "AI_SESSION_DEFER_MINUTES constant must equal 15",
    );

    // Extract deferIngestion body — ends just before the PDF branch section heading that follows it.
    const deferBody = extractBetween(src, "async function deferIngestion(", "\n// ── PDF branch");

    assert(
      deferBody.includes('status: "pending"'),
      "deferIngestion must set status = 'pending'",
    );
    assert(
      deferBody.includes("AI_SESSION_DEFER_MINUTES * 60 * 1000"),
      "deferIngestion must compute next_attempt_at using AI_SESSION_DEFER_MINUTES",
    );
    assert(
      deferBody.includes("await recordAiSessionDeferredPendingAlert("),
      "deferIngestion must record a deduped alert for the deferral",
    );
  },
);

Deno.test(
  "AC-3: deferIngestion() decrements attempts and pre-flight path returns early without writing chunks",
  async () => {
    const src = await Deno.readTextFile(ORCHESTRATOR);

    // deferIngestion must subtract 1 from the incoming counter to undo the earlier increment.
    const deferBody = extractBetween(src, "async function deferIngestion(", "\n// ── PDF branch");
    assert(
      deferBody.includes("attempts: currentAttempts - 1"),
      "deferIngestion must set attempts = currentAttempts - 1 to undo the earlier increment",
    );

    // The bridge from preflight call to the first branch entry must return early via deferIngestion
    // when the session is unavailable — so no chunk rows are written before the early exit.
    const bridge = extractBetween(
      src,
      "const ready = await preflight(session)",
      "if (isPdf) {",
    );
    assert(
      bridge.includes("return await deferIngestion("),
      "pre-flight failure path must return via deferIngestion() before any chunk rows are written",
    );
  },
);

Deno.test(
  "AC-4: successful preflight falls through to PDF/Municode branch without an extra return",
  async () => {
    const src = await Deno.readTextFile(ORCHESTRATOR);

    // The bridge from the preflight call to the PDF branch must contain exactly one `return`
    // (the one inside `if (!ready)`). Any additional return would prevent ingestion from proceeding.
    const bridge = extractBetween(
      src,
      "const ready = await preflight(session)",
      "if (isPdf) {",
    );

    const returnMatches = [...bridge.matchAll(/\breturn\b/g)];
    assert(
      returnMatches.length === 1,
      `Expected exactly 1 return between preflight call and PDF branch (found ${returnMatches.length})`,
    );
    assert(
      bridge.includes("if (!ready)"),
      "The single return must be guarded by if (!ready) — confirming the success path falls through",
    );
  },
);
