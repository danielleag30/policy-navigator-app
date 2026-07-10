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
