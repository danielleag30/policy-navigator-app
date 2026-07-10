/**
 * Pure parsing + decision logic for EnCode zoning-ordinance ingestion, split
 * out of encode.ts so it can be unit tested against fixture HTML without a
 * live network or database (mirrors the _municode-helpers.ts split, and the
 * reconciliation/_helpers.ts split before it, for the same reason).
 *
 * EnCode (online.encodeplus.com) has no JSON API like Municode's
 * /CodesContent -- it is an ASP.NET server-rendered tree browser. Two
 * endpoints matter for ingestion, both HTML-fragment responses:
 *
 *   GET toc-view.aspx?tocid=<dotted-path>&task=expand
 *     Returns the *entire* left-nav <ul> tree, with every ancestor of
 *     <dotted-path> shown expanded (so breadcrumb context renders) and the
 *     requested node's own direct children freshly expanded one level. Each
 *     <li id="secid-x{N}"> is either a leaf (fa-file-text-o.isLeaf, no
 *     onclick="ZP.TOCView.Expand(...)") or expandable (has
 *     onclick="ZP.TOCView.Expand('<child-dotted-path>')" -- that dotted path
 *     is what a later call passes as tocid to fetch *that* node's children).
 *     A single target's children always appear as the <ul class='toc-levelN'>
 *     immediately following its own <li id="secid-x{target}">...</li> (a
 *     sibling <li>, not nested inside it) -- extractTocChildren() locates
 *     that specific <li>, then depth-matches the following <ul>...</ul> so
 *     it can't be fooled by other already-expanded ancestor branches earlier
 *     or later in the same response.
 *
 *   GET doc-view.aspx?ajax=0&secid=<N>
 *     Returns a fragment whose actual body text lives in
 *     <div id="thePage" ... secid="{N}" ...>...</div> -- "thePage" is a
 *     CONSTANT id across every section; the section itself is identified by
 *     the `secid` attribute, not `id` (a first version of this parser
 *     assumed `id="{secid}"`, a false pattern from an unanchored substring
 *     search during scoping that happened to match inside `secid="{N}"` --
 *     caught by re-running the parser against real captured HTML, not just
 *     hand-written fixtures; see the regression test in
 *     tests/encode-ingestion.test.ts). Everything outside that div is
 *     print/share/nav chrome (breadcrumbs, "Previous/Next Section" buttons,
 *     etc.) that would otherwise pollute the extracted text.
 *     extractSectionText() locates and depth-matches that specific div,
 *     strips embedded <script> blocks and remaining tags, and decodes basic
 *     HTML entities -- the same stripHtml() shape municode.ts uses, applied
 *     to a properly scoped substring instead of a full-page fragment.
 */

// ── TOC tree parsing ─────────────────────────────────────────────────────────

export interface EncodeTocChild {
  secid: string;
  /** Dotted path to pass as `tocid` to expand this node's own children. Null for leaves. */
  tocid: string | null;
  heading: string;
  hasChildren: boolean;
}

/** Scans forward from `openIdx` (pointing at a `<TAG` open) to the index just past its matching close tag. */
function matchTagEnd(
  html: string,
  openIdx: number,
  tag: "ul" | "div",
): number {
  const openRe = new RegExp(`<${tag}\\b`, "g");
  const closeRe = new RegExp(`</${tag}>`, "g");
  let depth = 0;
  let cursor = openIdx;
  for (;;) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) return html.length;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      cursor = nextClose.index + nextClose[0].length;
      if (depth === 0) return cursor;
    }
  }
}

const LI_OPEN_RE = /<li\b/g;
const LI_CLOSE_RE = /<\/li>/g;

/** Splits a `<ul>...</ul>` block's outer HTML into its direct (depth-1) `<li>` chunks. */
function directLiChunks(ulBlockHtml: string): string[] {
  // ulBlockHtml starts at "<ul" and ends just past its matching "</ul>".
  const innerStart = ulBlockHtml.indexOf(">") + 1;
  const innerEnd = ulBlockHtml.lastIndexOf("</ul>");
  const inner = ulBlockHtml.slice(innerStart, innerEnd);

  const chunks: string[] = [];
  let depth = 0;
  let chunkStart = -1;
  let cursor = 0;
  for (;;) {
    LI_OPEN_RE.lastIndex = cursor;
    LI_CLOSE_RE.lastIndex = cursor;
    const nextOpen = LI_OPEN_RE.exec(inner);
    const nextClose = LI_CLOSE_RE.exec(inner);
    if (!nextOpen && !nextClose) break;
    if (nextOpen && (!nextClose || nextOpen.index < nextClose.index)) {
      if (depth === 0) chunkStart = nextOpen.index;
      depth += 1;
      cursor = nextOpen.index + 3;
    } else if (nextClose) {
      depth -= 1;
      cursor = nextClose.index + nextClose[0].length;
      if (depth === 0 && chunkStart !== -1) {
        chunks.push(inner.slice(chunkStart, cursor));
        chunkStart = -1;
      }
    } else {
      break;
    }
  }
  return chunks;
}

const SECID_RE = /id=["']secid-x(-?\d+)["']/;
const EXPAND_RE = /ZP\.TOCView\.Expand\(\s*['"]([^'"]+)['"]\s*\)/;
const HEADING_RE = /<span class=["']toc-item["']>([^<]*)<\/span>/;

function parseLiChunk(chunk: string): EncodeTocChild | null {
  // secid must come from this <li>'s OWN opening tag, not anywhere in the
  // chunk -- an anonymous wrapper "<li><ul>...</ul></li>" (used to nest an
  // already-expanded child's grandchildren) is itself a direct child of this
  // ul with no id of its own; naively searching the whole chunk would match
  // a grandchild's id inside it and synthesize a bogus entry.
  const openTagEnd = chunk.indexOf(">");
  const openTag = openTagEnd === -1 ? chunk : chunk.slice(0, openTagEnd + 1);
  const secidMatch = SECID_RE.exec(openTag);
  const headingMatch = HEADING_RE.exec(chunk);
  if (!secidMatch || !headingMatch) return null;

  const expandMatch = EXPAND_RE.exec(chunk);
  const tocid = expandMatch ? expandMatch[1] : null;

  return {
    secid: secidMatch[1],
    tocid,
    heading: headingMatch[1].trim(),
    hasChildren: tocid !== null,
  };
}

/**
 * Extracts the direct children of `parentSecid` from a toc-view.aspx
 * `task=expand` response. Returns an empty array if the parent's `<li>`
 * isn't found, or it has no following children `<ul>` (a leaf, or a node
 * whose own expand call hasn't been made yet).
 */
export function extractTocChildren(
  html: string,
  parentSecid: string,
): EncodeTocChild[] {
  const idNeedle = new RegExp(`id=["']secid-x${parentSecid}["']`);
  const idMatch = idNeedle.exec(html);
  if (!idMatch) return [];

  // The parent's own <li> contains only <a> tags (no nested <li>), so its
  // first </li> after the id match closes it.
  const parentLiClose = html.indexOf("</li>", idMatch.index);
  if (parentLiClose === -1) return [];

  // What immediately follows (modulo whitespace) should be "<li><ul ...>"
  // wrapping the children -- if it's anything else, this node has no
  // children in this response (leaf, or not yet expanded).
  const afterParent = html.slice(parentLiClose + "</li>".length);
  const wrapperMatch = /^\s*<li>\s*(<ul\b)/.exec(afterParent);
  if (!wrapperMatch) return [];

  const ulOpenIdx = parentLiClose + "</li>".length + wrapperMatch[0].length -
    wrapperMatch[1].length;
  const ulEndIdx = matchTagEnd(html, ulOpenIdx, "ul");
  const ulBlock = html.slice(ulOpenIdx, ulEndIdx);

  return directLiChunks(ulBlock)
    .map(parseLiChunk)
    .filter((c): c is EncodeTocChild => c !== null);
}

// ── Section content extraction ───────────────────────────────────────────────

/** Strip HTML tags and decode basic entities, returning plain text (mirrors municode.ts's stripHtml). */
function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Extracts plain-text body content for `secid` from a doc-view.aspx `ajax=0`
 * response, scoped to the `<div id="thePage" ... secid="{secid}" ...>` the
 * EnCode template always wraps section content in ("thePage" is a constant
 * id across every section -- the section itself is identified by the
 * `secid` attribute, not `id`) -- excluding the surrounding print/share/
 * breadcrumb chrome that lives in a preceding sibling div. Falls back to the
 * whole #doc-view-content fragment (chrome and all, minus <script> blocks)
 * if that div isn't present, so a template change degrades to noisier text
 * instead of losing the section entirely.
 */
export function extractSectionText(html: string, secid: string): string {
  const divNeedle = new RegExp(
    `<div\\s+id=["']thePage["'][^>]*\\bsecid=["']${secid}["']`,
  );
  const divMatch = divNeedle.exec(html);

  if (divMatch) {
    const divEndIdx = matchTagEnd(html, divMatch.index, "div");
    return stripTags(html.slice(divMatch.index, divEndIdx));
  }

  const contentMatch = /<div id=["']doc-view-content["']/.exec(html);
  if (!contentMatch) return "";
  const contentEndIdx = matchTagEnd(html, contentMatch.index, "div");
  return stripTags(html.slice(contentMatch.index, contentEndIdx));
}

// ── Orphaned-document recovery (mirrors _municode-helpers.ts) ────────────────

/** Shape of the documents row looked up by canonical URL. */
export interface EncodeOrphanDocumentRow {
  status: string;
  encode_resume_state: unknown;
}

export type EncodeOrphanRecoveryAction =
  | "insert-fresh"
  | "finalize-only"
  | "rewalk-from-root";

/**
 * Decide how handleEncode() should proceed when no status='current' document
 * matched the top-level content_hash, but a document row already exists at
 * the canonical EnCode URL. Identical decision logic to Municode's
 * classifyOrphanRecovery (_municode-helpers.ts) -- see that file's docstring
 * for the full rationale; kept as a separate function (rather than a shared
 * generic one) because the two source types have distinct resume-state
 * field names, matching the codebase's existing one-helpers-file-per-source
 * convention.
 */
export function classifyOrphanRecovery(
  orphan: EncodeOrphanDocumentRow | null,
  provisionCount: number,
): EncodeOrphanRecoveryAction {
  if (!orphan) return "insert-fresh";
  if (orphan.status === "current") return "insert-fresh";
  if (orphan.encode_resume_state !== null) return "insert-fresh";
  return provisionCount > 0 ? "finalize-only" : "rewalk-from-root";
}
