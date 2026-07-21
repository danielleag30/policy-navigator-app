/**
 * Tests for EnCode zoning-ordinance ingestion (feat/encode-zoning-ingestion).
 *
 * extractTocChildren/extractSectionText/classifyOrphanRecovery are pure and
 * unit tested directly here against fixture HTML captured from a live
 * request against https://online.encodeplus.com/regs/fairfaxcounty-va/
 * during scoping (trimmed for brevity, structure otherwise unmodified --
 * including the site's own markup quirks: mixed single/double quotes on
 * different <li> attributes, and a stray </a> after the isLeaf <i> tag).
 * Wiring into encode.ts/index.ts is verified via static source inspection,
 * matching the existing convention (tests/municode-orphan-recovery.test.ts,
 * tests/preflight.test.ts) since no live Supabase instance is available in CI.
 */

import {
  classifyOrphanRecovery,
  extractSectionText,
  extractTocChildren,
} from "../supabase/functions/ingest-orchestrator/_encode-helpers.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// extractTocChildren (pure HTML parsing)
// ---------------------------------------------------------------------------

// Root expand response (tocid=001&task=expand), trimmed from a live capture.
const ROOT_EXPAND_FIXTURE = `
<div id="toc-list" >
    <ul class='toc-level0' >
<li id='secid-x-1'><i class='fa fa-file-text-o' aria-hidden='true'></i><a href='/regs/fairfaxcounty-va/doc-viewer.aspx?secid=-1' onclick='ZP.TOCView.SelectTOC(-1,false); return false;'><span class='toc-item'>Table of Contents</span></a></li>
    <li id="secid-x2214" class="tocLink selected"><a href="#" onclick="ZP.TOCView.Expand(''); return false;" role="button">
        <img class="expander" alt="Collapse"  src="resources/browserimages/minus_sign.gif" /><i class="fa fa-folder-open" aria-hidden="true"></i></a>
        <a href="/regs/fairfaxcounty-va/doc-viewer.aspx?secid=2214" onclick="ZP.TOCView.SelectTOC('2214',true); return false;"><span class="toc-item">Fairfax County Zoning Ordinance</span></a></li>
    <li><ul class='toc-level1' >

    <li id="secid-x2215" class="tocLink "><i class="fa fa-file-text-o isLeaf" aria-hidden="true"></i></a>
        <a href="/regs/fairfaxcounty-va/doc-viewer.aspx?secid=2215" onclick="ZP.TOCView.SelectTOC('2215',false); return false;"><span class="toc-item">Cover Page</span></a></li>

    <li id="secid-x2217" class="tocLink "><a href="#" onclick="ZP.TOCView.Expand('001.002'); return false;" role="button">
        <img class="expander" alt="Expand"  src="resources/browserimages/plus_sign.gif" /><i class="fa fa-folder" aria-hidden="true"></i></a>
        <a href="/regs/fairfaxcounty-va/doc-viewer.aspx?secid=2217" onclick="ZP.TOCView.SelectTOC('2217',true); return false;"><span class="toc-item">Article 1 - General Provisions</span></a></li>

    <li id="secid-x2245" class="tocLink "><a href="#" onclick="ZP.TOCView.Expand('001.006'); return false;" role="button">
        <img class="expander" alt="Expand"  src="resources/browserimages/plus_sign.gif" /><i class="fa fa-folder" aria-hidden="true"></i></a>
        <a href="/regs/fairfaxcounty-va/doc-viewer.aspx?secid=2245" onclick="ZP.TOCView.SelectTOC('2245',true); return false;"><span class="toc-item">Article 5 - Development Standards</span></a></li>

    <li id="secid-x3044" class="tocLink "><i class="fa fa-file-text-o isLeaf" aria-hidden="true"></i></a>
        <a href="/regs/fairfaxcounty-va/doc-viewer.aspx?secid=3044" onclick="ZP.TOCView.SelectTOC('3044',false); return false;"><span class="toc-item">Amendment History Table</span></a></li>
    </ul>

</div><!--toc-list-->
`;

Deno.test("extractTocChildren: parses root's direct children (leaf + expandable + prefixed onclick)", () => {
  const children = extractTocChildren(ROOT_EXPAND_FIXTURE, "2214");
  assertEquals(children.length, 4);

  assertEquals(children[0], {
    secid: "2215",
    tocid: null,
    heading: "Cover Page",
    hasChildren: false,
  });
  assertEquals(children[1], {
    secid: "2217",
    tocid: "001.002",
    heading: "Article 1 - General Provisions",
    hasChildren: true,
  });
  assertEquals(children[3], {
    secid: "3044",
    tocid: null,
    heading: "Amendment History Table",
    hasChildren: false,
  });
});

Deno.test("extractTocChildren: does not confuse the 'Table of Contents' pseudo-entry (secid -1) with the ordinance root", () => {
  const children = extractTocChildren(ROOT_EXPAND_FIXTURE, "-1");
  assertEquals(
    children,
    [],
    "secid -1 has no children block of its own in this fixture",
  );
});

// Nested expand response (tocid=001.006.001&task=expand) -- ancestor path
// (Article 5, node 2246) pre-expanded, target node 2246 additionally shows
// its own children (2556-2558), matching live-observed path-expansion behavior.
const NESTED_EXPAND_FIXTURE = `
<li id="secid-x2245" class="tocLink selected"><a href="#" onclick="ZP.TOCView.Expand(''); return false;" role="button"></a>
    <a href="/regs/fairfaxcounty-va/doc-viewer.aspx?secid=2245" onclick="ZP.TOCView.SelectTOC('2245',true); return false;"><span class="toc-item">Article 5 - Development Standards</span></a></li>
<li><ul class='toc-level2' >

    <li id="secid-x2246" class="tocLink "><a href="#" onclick="ZP.TOCView.Expand('001.006.001'); return false;" role="button">
        <img class="expander" alt="Collapse"  src="resources/browserimages/minus_sign.gif" /></a>
        <a href="/regs/fairfaxcounty-va/doc-viewer.aspx?secid=2246" onclick="ZP.TOCView.SelectTOC('2246',true); return false;"><span class="toc-item">5100. Lot, Bulk, and Open Space Regulations</span></a></li>
    <li><ul class='toc-level3' >

    <li id="secid-x2556" class="tocLink "><i class="fa fa-file-text-o isLeaf" aria-hidden="true"></i></a>
        <a href="/regs/fairfaxcounty-va/doc-viewer.aspx?secid=2556" onclick="ZP.TOCView.SelectTOC('2556',false); return false;"><span class="toc-item">5100.1 General Dimensional Standards</span></a></li>

    <li id="secid-x2557" class="tocLink "><a href="#" onclick="ZP.TOCView.Expand('001.006.001.002'); return false;" role="button">
        <img class="expander" alt="Expand"  src="resources/browserimages/plus_sign.gif" /></a>
        <a href="/regs/fairfaxcounty-va/doc-viewer.aspx?secid=2557" onclick="ZP.TOCView.SelectTOC('2557',true); return false;"><span class="toc-item">5100.2 Lot and Bulk Regulations</span></a></li>
    </ul></li>

    <li id="secid-x2247" class="tocLink "><a href="#" onclick="ZP.TOCView.Expand('001.006.002'); return false;" role="button">
        <img class="expander" alt="Expand"  src="resources/browserimages/plus_sign.gif" /></a>
        <a href="/regs/fairfaxcounty-va/doc-viewer.aspx?secid=2247" onclick="ZP.TOCView.SelectTOC('2247',true); return false;"><span class="toc-item">5101. Affordable Dwelling Unit Program</span></a></li>
    </ul></li>
`;

Deno.test("extractTocChildren: isolates a target's own children when an ancestor's sibling list is also present (path expansion)", () => {
  const article5Children = extractTocChildren(NESTED_EXPAND_FIXTURE, "2245");
  assertEquals(article5Children.length, 2);
  assertEquals(article5Children.map((c) => c.secid), ["2246", "2247"]);
});

Deno.test("extractTocChildren: reaches a grandchild block nested inside a further-expanded child", () => {
  const lotBulkChildren = extractTocChildren(NESTED_EXPAND_FIXTURE, "2246");
  assertEquals(lotBulkChildren.length, 2);
  assertEquals(lotBulkChildren[0], {
    secid: "2556",
    tocid: null,
    heading: "5100.1 General Dimensional Standards",
    hasChildren: false,
  });
  assertEquals(lotBulkChildren[1].hasChildren, true);
  assertEquals(lotBulkChildren[1].tocid, "001.006.001.002");
});

Deno.test("extractTocChildren: node with no matching <li> in the response returns empty (not-yet-expanded or unknown secid)", () => {
  assertEquals(extractTocChildren(ROOT_EXPAND_FIXTURE, "99999"), []);
});

Deno.test("extractTocChildren: leaf node (no Expand() onclick) returns empty even if its id is present", () => {
  assertEquals(extractTocChildren(ROOT_EXPAND_FIXTURE, "2215"), []);
});

// ---------------------------------------------------------------------------
// extractSectionText (pure HTML parsing)
// ---------------------------------------------------------------------------

const SECTION_CONTENT_FIXTURE = `
<div id="doc-view-content">
<div id="pageControls">
<script type="text/javascript">function clearEffDate() { jQuery.get("doc-view-helper.aspx?task=currentversion"); }</script>
<div class="pageControls_inner breadCrumbs"><div class='breadCrumbs'>Fairfax County Zoning Ordinance &gt; 5100.2 Lot and Bulk Regulations</div></div>
</div>
<div id="thePage-outer"><div id="thePage-wrap">
<div id="thePage" class="textPage " tocid="001.006.001.002" secid="2557" role="main" aria-label="Document">
<section id='secid-2557' class='secLvl4'>
<h4>Lot and Bulk Regulations</h4>
</section>
<section id='secid-2908' class='secLvl5'>
<div class="li-cont">A. Lot Size Regulations
<div class="li-cont">(1) Minimum lot area for the R-1 District is <b>36,000 square feet</b>.</div>
</div>
</section>
</div>
</div></div>
</div>
`;

Deno.test("extractSectionText: scopes extraction to the id=thePage/secid-matching div, excluding pageControls/breadcrumb chrome", () => {
  // Regression: the section wrapper's `id` is the CONSTANT "thePage" across
  // every section -- the section is identified by its `secid` attribute, not
  // `id`. A first version of this parser matched on `id="{secid}"` (a false
  // pattern from a naive unanchored substring search during scoping that
  // happened to match inside `secid="2557"`), which silently fell through to
  // the #doc-view-content fallback for every real page and leaked breadcrumb
  // text ("Fairfax County Zoning Ordinance > ... Bookmark") into every
  // ingested section. Caught by re-running this parser against real captured
  // EnCode HTML, not just hand-written fixtures.
  const text = extractSectionText(SECTION_CONTENT_FIXTURE, "2557");
  assert(
    text.includes(
      "Minimum lot area for the R-1 District is 36,000 square feet",
    ),
    `expected real regulation text, got: ${text}`,
  );
  assert(
    !text.includes("Fairfax County Zoning Ordinance"),
    `breadcrumb text must be excluded (scoped extraction, not the chrome-including fallback), got: ${text}`,
  );
  assert(!text.includes("breadCrumbs"), "breadcrumb chrome must be excluded");
  assert(
    !text.includes("clearEffDate"),
    "inline <script> content must be stripped",
  );
  assert(
    !text.includes("doc-view-helper.aspx"),
    "pageControls chrome must be excluded",
  );
});

Deno.test("extractSectionText: falls back to the whole #doc-view-content fragment (scripts still stripped) when the secid div is missing", () => {
  const html =
    `<div id="doc-view-content"><script>var x=1;</script><p>Amendment History Table text</p></div>`;
  const text = extractSectionText(html, "3044");
  assertEquals(text, "Amendment History Table text");
});

Deno.test("extractSectionText: returns empty string when neither the secid div nor #doc-view-content is present", () => {
  assertEquals(extractSectionText("<div>unrelated page</div>", "2557"), "");
});

// ---------------------------------------------------------------------------
// classifyOrphanRecovery (pure logic — mirrors municode-orphan-recovery.test.ts)
// ---------------------------------------------------------------------------

Deno.test("classifyOrphanRecovery: no document at URL → insert-fresh", () => {
  assertEquals(classifyOrphanRecovery(null, 0), "insert-fresh");
  assertEquals(classifyOrphanRecovery(null, 900), "insert-fresh");
});

Deno.test("classifyOrphanRecovery: existing document already 'current' → insert-fresh", () => {
  const orphan = { status: "current", encode_resume_state: null };
  assertEquals(classifyOrphanRecovery(orphan, 900), "insert-fresh");
});

Deno.test("classifyOrphanRecovery: existing document still holds a resume_state → insert-fresh (findResumableDocument's territory)", () => {
  const orphan = {
    status: "unknown",
    encode_resume_state: { effectiveDate: "2026-01-01", queue: [] },
  };
  assertEquals(classifyOrphanRecovery(orphan, 500), "insert-fresh");
});

Deno.test("classifyOrphanRecovery: not-current + null resume_state + provisions already written → finalize-only", () => {
  const orphan = { status: "unknown", encode_resume_state: null };
  assertEquals(classifyOrphanRecovery(orphan, 900), "finalize-only");
  assertEquals(classifyOrphanRecovery(orphan, 1), "finalize-only");
});

Deno.test("classifyOrphanRecovery: not-current + null resume_state + zero provisions → rewalk-from-root", () => {
  const orphan = { status: "unknown", encode_resume_state: null };
  assertEquals(classifyOrphanRecovery(orphan, 0), "rewalk-from-root");
});

// ---------------------------------------------------------------------------
// Static source-inspection: wiring inside encode.ts / index.ts
// ---------------------------------------------------------------------------

const ENCODE_SRC = new URL(
  "../supabase/functions/ingest-orchestrator/encode.ts",
  import.meta.url,
).pathname;
const ORCHESTRATOR_SRC = new URL(
  "../supabase/functions/ingest-orchestrator/index.ts",
  import.meta.url,
).pathname;

Deno.test("wiring: encode.ts imports classifyOrphanRecovery/extractTocChildren/extractSectionText from _encode-helpers.ts", async () => {
  const src = await Deno.readTextFile(ENCODE_SRC);
  assert(
    src.includes('from "./_encode-helpers.ts"'),
    "encode.ts must import from _encode-helpers.ts",
  );
  assert(
    src.includes("classifyOrphanRecovery"),
    "must use classifyOrphanRecovery",
  );
  assert(src.includes("extractTocChildren"), "must use extractTocChildren");
  assert(src.includes("extractSectionText"), "must use extractSectionText");
});

Deno.test("wiring: encode.ts namespaces node ids to avoid colliding with real Municode node ids in the shared column", async () => {
  const src = await Deno.readTextFile(ENCODE_SRC);
  assert(
    src.includes('NODE_ID_PREFIX = "encode:"'),
    "encode.ts must namespace municode_node_id values it writes",
  );
});

Deno.test("wiring: encode.ts's per-node upsert sets source_type: encode_zoning", async () => {
  const src = await Deno.readTextFile(ENCODE_SRC);
  assert(
    src.includes('source_type: "encode_zoning"'),
    "upsertProvision must tag rows with source_type",
  );
});

Deno.test("wiring: encode.ts uses a deadline-aware iterative (stack pop/push) walk, not unbounded recursion", async () => {
  const src = await Deno.readTextFile(ENCODE_SRC);
  assert(
    src.includes("queue.pop()"),
    "drainQueue must pop from an explicit stack",
  );
  assert(
    src.includes("deadlineMs - DEADLINE_BUFFER_MS"),
    "drainQueue must check the soft deadline before each item",
  );
  assert(
    src.includes("encode_resume_state: state"),
    "drainQueue must persist resume state on deadline exhaustion",
  );
});

Deno.test("wiring: index.ts branches on encode_zoning and calls handleEncode", async () => {
  const src = await Deno.readTextFile(ORCHESTRATOR_SRC);
  assert(
    src.includes('import { handleEncode } from "./encode.ts"'),
    "index.ts must import handleEncode",
  );
  assert(
    src.includes('row.doc_type === "encode_zoning"'),
    "index.ts must branch on doc_type === encode_zoning",
  );
  assert(
    src.includes("await handleEncode("),
    "index.ts must call handleEncode",
  );
});

Deno.test("wiring: the encode_zoning branch embeds via the external HTTP path (embedOrdinanceProvisionsBatched), not a fresh embedding implementation", async () => {
  const src = await Deno.readTextFile(ORCHESTRATOR_SRC);
  const encodeBranchStart = src.indexOf("// ── EnCode zoning branch");
  assert(encodeBranchStart !== -1, "EnCode branch section marker not found");
  const encodeBranchEnd = src.indexOf(
    "throw new Error(`Unknown doc_type",
    encodeBranchStart,
  );
  const branch = src.slice(encodeBranchStart, encodeBranchEnd);
  assert(
    branch.includes("embedOrdinanceProvisionsBatched("),
    "encode_zoning branch must reuse embedOrdinanceProvisionsBatched (PR #83/#89's HTTP embedding path)",
  );
  assert(
    !branch.includes("Supabase.ai.Session"),
    "encode_zoning branch must not construct its own in-process AI Session for embedding",
  );
});

Deno.test("wiring: encode_zoning branch triggers reconciliation after finalizing changed EnCode content", async () => {
  const src = await Deno.readTextFile(ORCHESTRATOR_SRC);
  const encodeBranchStart = src.indexOf("// ── EnCode zoning branch");
  assert(encodeBranchStart !== -1, "EnCode branch section marker not found");
  const encodeBranchEnd = src.indexOf(
    "throw new Error(`Unknown doc_type",
    encodeBranchStart,
  );
  const branch = src.slice(encodeBranchStart, encodeBranchEnd);

  const finalizationIdx = branch.indexOf('.from("documents")');
  const triggerIdx = branch.indexOf("triggerReconciliationIfNeeded");
  const doneIdx = branch.indexOf('.from("pending_ingestions")');

  assert(triggerIdx !== -1, "EnCode branch must trigger reconciliation");
  assert(
    finalizationIdx !== -1 && finalizationIdx < triggerIdx,
    "EnCode reconciliation must run after document finalization",
  );
  assert(
    doneIdx !== -1 && triggerIdx < doneIdx,
    "EnCode reconciliation must run before marking the ingestion done",
  );
  assert(
    branch.includes("supplementJobId: `encode:${documentId}`"),
    "EnCode reconciliation must use a namespaced publication signal",
  );
});

// ---------------------------------------------------------------------------
// ENCODE_ZONING_ENABLED compliance gate (blocking fix -- codex cross-vendor
// review of PR #92): EnCode's robots.txt disallows /regs/ for generic bots,
// so nothing may hit the site on an unattended schedule without this gate
// checked at BOTH call sites -- change-detection (before a fresh
// pending_ingestion row is created) and ingest-orchestrator (before
// handleEncode makes any fetch/db call). No live Supabase instance is
// available in CI (see file header), so these are static source-inspection
// tests like the rest of this file, not behavioral db-mocked tests.
// ---------------------------------------------------------------------------

const CHANGE_DETECTION_ORCHESTRATE_SRC = new URL(
  "../supabase/functions/change-detection/_orchestrate.ts",
  import.meta.url,
).pathname;

function extractBetween(
  src: string,
  startMarker: string,
  endMarker: string,
): string {
  const startIdx = src.indexOf(startMarker);
  assert(startIdx !== -1, `Start marker not found: "${startMarker}"`);
  const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  assert(endIdx !== -1, `End marker not found after start: "${endMarker}"`);
  return src.slice(startIdx, endIdx);
}

Deno.test("gate: checkEncodeZoning (change-detection) checks ENCODE_ZONING_ENABLED before creating a pending_ingestion row", async () => {
  const src = await Deno.readTextFile(CHANGE_DETECTION_ORCHESTRATE_SRC);
  const fnBody = extractBetween(
    src,
    "async function checkEncodeZoning(",
    "\nasync function writeStalenessAlerts",
  );

  const gateIdx = fnBody.indexOf("!deps.isEncodeZoningEnabled()");
  const createIdx = fnBody.indexOf("await createPendingIngestionIfAbsent(");

  assert(gateIdx !== -1, "checkEncodeZoning must check ENCODE_ZONING_ENABLED");
  assert(
    createIdx !== -1,
    "checkEncodeZoning must still call createPendingIngestionIfAbsent on the enabled path",
  );
  assert(
    gateIdx < createIdx,
    "the ENCODE_ZONING_ENABLED check must appear before createPendingIngestionIfAbsent is called",
  );
});

Deno.test("gate: checkEncodeZoning returns without a pending_ingestion_id when the gate is off", async () => {
  const src = await Deno.readTextFile(CHANGE_DETECTION_ORCHESTRATE_SRC);
  const fnBody = extractBetween(
    src,
    "async function checkEncodeZoning(",
    "\nasync function writeStalenessAlerts",
  );
  const gateBlock = extractBetween(
    fnBody,
    "if (!deps.isEncodeZoningEnabled()) {",
    "}",
  );
  assert(
    gateBlock.includes("checked: false") &&
      gateBlock.includes("pending_ingestion_id: null"),
    `gate-off branch must return { checked: false, pending_ingestion_id: null }, got: ${gateBlock}`,
  );
});

Deno.test("gate: handleEncode (ingest-orchestrator) checks ENCODE_ZONING_ENABLED before any fetch or resumable-document lookup", async () => {
  const src = await Deno.readTextFile(ENCODE_SRC);
  const fnBody = extractBetween(
    src,
    "export async function handleEncode(",
    "\n  const baseUrl = envOrDefault",
  );

  const gateIdx = fnBody.indexOf(
    'Deno.env.get("ENCODE_ZONING_ENABLED") !== "true"',
  );
  const resumableIdx = src.indexOf("await findResumableDocument()");
  const versionSignalIdx = src.indexOf("await fetchVersionSignalHash(");

  assert(gateIdx !== -1, "handleEncode must check ENCODE_ZONING_ENABLED");
  assert(
    resumableIdx !== -1 && versionSignalIdx !== -1,
    "handleEncode must still reach the resumable-document lookup and version-signal fetch on the enabled path",
  );
  // gateIdx is an offset into fnBody (which starts at "export async function
  // handleEncode("), so compare against the same-origin offsets.
  const handleEncodeStart = src.indexOf("export async function handleEncode(");
  assert(
    handleEncodeStart + gateIdx < resumableIdx &&
      handleEncodeStart + gateIdx < versionSignalIdx,
    "the ENCODE_ZONING_ENABLED check must run before any network/db lookup in handleEncode",
  );
});

Deno.test("gate: handleEncode marks the pending_ingestion row 'skipped' with a clear reason and makes no fetch() call when disabled", async () => {
  const src = await Deno.readTextFile(ENCODE_SRC);
  const gateBlock = extractBetween(
    src,
    'Deno.env.get("ENCODE_ZONING_ENABLED") !== "true") {',
    'return { documentId: "", nodeIds: [], skipped: true, complete: true };',
  );
  assert(
    gateBlock.includes('status: "skipped"'),
    "disabled-gate branch must mark the pending_ingestion row status: 'skipped'",
  );
  assert(
    gateBlock.includes("last_error:"),
    "disabled-gate branch must record a clear reason via last_error",
  );
  assert(
    !gateBlock.includes("fetch("),
    "disabled-gate branch must not make any fetch() call",
  );
});

// ---------------------------------------------------------------------------
// Partial-failure must block finalization (blocking fix -- codex cross-vendor
// review of PR #92): a per-node content or child-TOC fetch failure inside
// processNode() must not let drainQueue() return complete: true, because
// index.ts flips documents.status to 'current' immediately after a
// complete: true / skipped: false result -- an entire subtree silently
// vanishing must not be presented as a complete, verified ordinance.
// ---------------------------------------------------------------------------

Deno.test("partial-failure: processNode reports failed:true (not just a console warning) when the content fetch throws", async () => {
  const src = await Deno.readTextFile(ENCODE_SRC);
  const fnBody = extractBetween(
    src,
    "async function processNode(",
    "\n/** Push a node's children",
  );

  const contentCatch = extractBetween(
    fnBody,
    "try {\n    plainContent = await fetchSectionContent(",
    "if (plainContent) {",
  );
  assert(
    contentCatch.includes("failed = true"),
    "the content-fetch catch block must set failed = true, not just log",
  );
});

Deno.test("partial-failure: processNode reports failed:true when the child-TOC fetch throws (not just an empty children array)", async () => {
  const src = await Deno.readTextFile(ENCODE_SRC);
  const fnBody = extractBetween(
    src,
    "async function processNode(",
    "\n/** Push a node's children",
  );

  const childrenCatchBlock = extractBetween(
    fnBody,
    "} catch (e) {\n    console.warn(\n      `[encode] children fetch failed",
    "\n  }\n}",
  );
  assert(
    childrenCatchBlock.includes("failed: true"),
    `children-fetch catch block must return failed: true (not silently return an empty array), got: ${childrenCatchBlock}`,
  );
});

Deno.test("partial-failure: drainQueue persists resume state and throws (never returns complete: true) when a node reports failed", async () => {
  const src = await Deno.readTextFile(ENCODE_SRC);
  const fnBody = extractBetween(
    src,
    "async function drainQueue(",
    "\n/** Minutes an exclusive resume-claim lease",
  );

  const failureBlock = extractBetween(
    fnBody,
    "if (failed) {",
    "if (children.length > 0) {",
  );
  assert(
    failureBlock.includes("persistResumeState(queue, ctx)"),
    "the failure branch must persist resume state so progress/retry position is not lost",
  );
  assert(
    failureBlock.includes("throw new Error("),
    "the failure branch must throw rather than return, so index.ts never reaches the finalize-as-current step",
  );
  assert(
    !failureBlock.includes("complete: true") &&
      !failureBlock.includes("return {"),
    "the failure branch must not itself construct an EncodeResult (no complete:true/false return) -- it must throw",
  );
});

Deno.test("partial-failure: the failure branch requeues the failed item itself (not just the remaining stack) for retry", async () => {
  const src = await Deno.readTextFile(ENCODE_SRC);
  const fnBody = extractBetween(
    src,
    "async function drainQueue(",
    "\n/** Minutes an exclusive resume-claim lease",
  );
  const failureBlock = extractBetween(
    fnBody,
    "if (failed) {",
    "if (children.length > 0) {",
  );
  assert(
    failureBlock.includes("queue.push(item)"),
    "the failed node must be pushed back onto the queue before persisting resume state, so retry re-attempts it",
  );
});

Deno.test("wiring: encode_zoning is a recognized doc_type in the discovery-crawler's DocType union and seed-sources.json", async () => {
  const discoverySrc = await Deno.readTextFile(
    new URL(
      "../supabase/functions/change-detection/_discovery.ts",
      import.meta.url,
    ).pathname,
  );
  assert(
    discoverySrc.includes('"encode_zoning"'),
    "_discovery.ts DocType union must include encode_zoning",
  );

  const seedConfig = JSON.parse(
    await Deno.readTextFile(
      new URL("../supabase/config/seed-sources.json", import.meta.url).pathname,
    ),
  );
  const encodeSource = seedConfig.sources.find(
    (s: { id?: string }) => s.id === "encode_zoning",
  );
  assert(
    encodeSource,
    "seed-sources.json must have an encode_zoning source entry",
  );
  assertEquals(encodeSource.doc_type, "encode_zoning");
  assert(
    typeof encodeSource.base_url === "string" &&
      encodeSource.base_url.includes("encodeplus.com"),
    "encode_zoning source must point at online.encodeplus.com",
  );
});

Deno.test("wiring: recently adopted zoning amendments page is an independent PDF discovery source", async () => {
  const seedConfig = JSON.parse(
    await Deno.readTextFile(
      new URL("../supabase/config/seed-sources.json", import.meta.url).pathname,
    ),
  );
  const source = seedConfig.sources.find(
    (s: { id?: string }) => s.id === "zoning_recently_adopted_amendments",
  );

  assert(
    source,
    "seed-sources.json must include the recently adopted amendments source",
  );
  assertEquals(source.doc_type, "bos_summary");
  assert(
    source.discovery_urls.some((url: string) =>
      url ===
        "https://www.fairfaxcounty.gov/planning-development/zoning-ordinance/amendments/recently-adopted"
    ),
    "recently adopted source must crawl the county listing page",
  );
  assert(
    source.allow_patterns.some((pattern: string) =>
      pattern.startsWith("https://plus.fairfaxcounty.gov/")
    ),
    "recently adopted source must allow PLUS attachment downloads",
  );
  assert(
    source.allow_patterns.some((pattern: string) =>
      pattern.includes("Zoning%20Ordinance/Adopted%20Amendments/")
    ),
    "recently adopted source must allow county-hosted adopted amendment PDFs",
  );
});
