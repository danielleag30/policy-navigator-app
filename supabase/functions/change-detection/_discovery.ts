/**
 * Discovery seed config + pure crawl primitives for change-detection.
 *
 * Split out from index.ts (which has a top-level Deno.serve() and so isn't
 * safe to import from a test) so the depth/allow-pattern/match-priority
 * logic can be unit tested against fixture HTML without a live network or
 * database.
 *
 * seed-sources.json mixes two source shapes:
 *   - discovery sources: { discovery_urls, discovery_depth, allow_patterns, ... }
 *     crawled via _crawl_state.ts's resumable per-source cycle to find
 *     candidate document URLs (board minutes, budget PDFs).
 *   - legacy/API sources: { base_url, url_patterns } (municode_api,
 *     encode_zoning) -- not crawled, checked directly via one fetch.
 *
 * This module previously also owned the whole-source, non-resumable BFS
 * crawl (crawlDiscoverySource/discoverAllCandidates/resolveCandidates): a
 * single invocation would fetch every page of every source's tree in one
 * unbounded pass. That shape has no natural place to checkpoint mid-crawl,
 * which was the root cause of change-detection losing all progress every
 * IDLE_TIMEOUT tick. _crawl_state.ts replaces it with a per-source,
 * per-batch-checkpointed loop built from the same primitives kept here
 * (extractLinks, matchesAllowPattern, sameHostname, meetsFollowRecency) plus
 * resolveOwnerSourceId below -- a per-URL version of the old
 * resolveCandidates' cross-source match_priority resolution, since which
 * source owns a URL is a pure function of the URL and the static source
 * configs, not of crawl order, and so can be resolved the moment a URL is
 * discovered rather than only after every source's crawl fully completes.
 */

export type DocType =
  | "budget_pdf"
  | "bos_minutes"
  | "bos_summary"
  | "ordinance"
  | "municode_api"
  | "encode_zoning";

export interface DiscoverySource {
  id: string;
  doc_type: DocType;
  label?: string;
  discovery_urls: string[];
  discovery_depth: number;
  discovery_note?: string;
  allow_patterns: string[];
  /**
   * Restricts which same-hostname links get followed to the next crawl depth
   * to those starting with this prefix (e.g. an origin+section like
   * "https://www.fairfaxcounty.gov/budget/"). Does not affect which links are
   * recorded as discovered candidates — only which pages the crawler recurses
   * into. Omit to follow every same-hostname link, as before.
   */
  discovery_link_prefix?: string;
  /**
   * Restricts recursion to links whose URL ends in a 4-digit year
   * (e.g. "...-march-10-2026") of at least this value. Links with no trailing
   * year are unaffected (always followed, subject to the other checks) since
   * they're typically a handful of evergreen section pages, not per-item
   * archive pages. Intended for sources whose per-item pages are individually
   * dated and go back many years further than the product needs to track for
   * change detection — trades off never discovering older archived items for
   * keeping each run's page-fetch and candidate-scan volume inside the edge
   * function's execution budget. Omit to follow every dated link regardless
   * of year, as before.
   */
  discovery_follow_min_year?: number;
  /** Lower number wins when a URL matches more than one source's allow_patterns. */
  match_priority?: number;
  casing_note?: string;
  examples?: string[];
}

export interface ApiSource {
  id?: string;
  doc_type: DocType;
  label?: string;
  base_url: string;
  url_patterns: string[];
  notes?: string;
}

export type SeedSource = DiscoverySource | ApiSource;

export interface SeedConfig {
  version: string;
  scraper_notes?: string[];
  sources: SeedSource[];
}

export interface DiscoveredUrl {
  url: string;
  docType: DocType;
  sourceId: string;
  label: string;
}

export interface PageFetchResult {
  ok: boolean;
  status: number;
  html: string;
}

export type PageFetcher = (url: string) => Promise<PageFetchResult>;

export interface CrawlError {
  url: string;
  message: string;
}

export interface DiscoveryError extends CrawlError {
  sourceId: string;
  docType: DocType;
}

// A safety cap, not an expected ceiling — confirmed live 2026-07-07 that a
// single large listing page (budget-committee-meetings, 15+ years of history)
// alone yields 300+ unique same-host non-document links to follow at depth 2.
// 200 silently truncated the queue before reaching most real meeting pages.
export const DEFAULT_MAX_PAGES = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isDiscoverySource(
  source: SeedSource,
): source is DiscoverySource {
  return Array.isArray((source as DiscoverySource).discovery_urls);
}

export function validateSeedConfig(value: unknown): SeedConfig {
  if (!isRecord(value) || !Array.isArray(value.sources)) {
    throw new Error("seed-sources.json must contain a sources array");
  }

  for (const [idx, raw] of value.sources.entries()) {
    if (!isRecord(raw)) {
      throw new Error(`seed source at index ${idx} must be an object`);
    }
    if (typeof raw.doc_type !== "string") {
      throw new Error(`seed source at index ${idx} is missing doc_type`);
    }

    const hasDiscoveryShape = Array.isArray(raw.discovery_urls);
    const hasApiShape = typeof raw.base_url === "string" &&
      Array.isArray(raw.url_patterns);

    if (hasDiscoveryShape) {
      if (
        typeof raw.id !== "string" ||
        typeof raw.discovery_depth !== "number" ||
        !Array.isArray(raw.allow_patterns)
      ) {
        throw new Error(
          `discovery seed source at index ${idx} must have id/discovery_depth/allow_patterns`,
        );
      }
      if (
        raw.discovery_link_prefix !== undefined &&
        typeof raw.discovery_link_prefix !== "string"
      ) {
        throw new Error(
          `discovery seed source at index ${idx} has a non-string discovery_link_prefix`,
        );
      }
      if (
        raw.discovery_follow_min_year !== undefined &&
        typeof raw.discovery_follow_min_year !== "number"
      ) {
        throw new Error(
          `discovery seed source at index ${idx} has a non-number discovery_follow_min_year`,
        );
      }
    } else if (!hasApiShape) {
      throw new Error(
        `seed source at index ${idx} must have either discovery_urls+discovery_depth+allow_patterns ` +
          `or base_url+url_patterns`,
      );
    }
  }

  return value as unknown as SeedConfig;
}

export function discoverySourcesOf(config: SeedConfig): DiscoverySource[] {
  return config.sources.filter(isDiscoverySource);
}

export function apiSourcesOf(config: SeedConfig): ApiSource[] {
  return config.sources.filter((s): s is ApiSource => !isDiscoverySource(s));
}

// ── Link extraction ──────────────────────────────────────────────────────────

const HREF_PATTERN = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SKIP_HREF_PREFIXES = ["#", "javascript:", "mailto:", "tel:"];

/**
 * Extracts absolute link URLs from an HTML page's <a href> tags. Resolves
 * relative hrefs against pageUrl. Preserves exact path/query casing — only
 * the URL constructor's scheme/hostname normalization applies, never the path.
 */
export function extractLinks(html: string, pageUrl: string): string[] {
  const links: string[] = [];

  for (const match of html.matchAll(HREF_PATTERN)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw) continue;
    if (
      SKIP_HREF_PREFIXES.some((prefix) => raw.toLowerCase().startsWith(prefix))
    ) {
      continue;
    }

    try {
      links.push(new URL(raw, pageUrl).toString());
    } catch {
      // Malformed href — skip rather than fail the whole page.
    }
  }

  return links;
}

export function sameHostname(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

export function matchesAllowPattern(
  url: string,
  source: DiscoverySource,
): boolean {
  return source.allow_patterns.some((pattern) => url.startsWith(pattern));
}

const DOCUMENT_EXTENSIONS = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".zip"];

/** True for links that are clearly a document, not an HTML navigation page. */
export function looksLikeDocumentUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return DOCUMENT_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

/** Extracts a trailing "-YYYY" year from a URL's path, e.g. ".../meeting-march-10-2026" → 2026. */
export function trailingYearOf(url: string): number | null {
  try {
    const match = new URL(url).pathname.match(/-(\d{4})$/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function meetsFollowRecency(
  url: string,
  source: DiscoverySource,
): boolean {
  if (source.discovery_follow_min_year === undefined) return true;
  const year = trailingYearOf(url);
  return year === null || year >= source.discovery_follow_min_year;
}

/**
 * True for a link the crawler should recurse into at the next depth: not
 * already visited, not itself a terminal candidate, same hostname as the
 * page it was found on, inside discovery_link_prefix (if set), meeting
 * discovery_follow_min_year (if set), and under the maxPages visited cap.
 */
export function shouldFollowLink(
  link: string,
  pageUrl: string,
  depth: number,
  source: DiscoverySource,
  visited: ReadonlySet<string>,
  maxPages: number,
): boolean {
  if (depth >= source.discovery_depth) return false;
  if (visited.has(link)) return false;
  if (visited.size >= maxPages) return false;
  if (matchesAllowPattern(link, source) || looksLikeDocumentUrl(link)) {
    return false;
  }
  if (!sameHostname(link, pageUrl)) return false;
  if (
    source.discovery_link_prefix !== undefined &&
    !link.startsWith(source.discovery_link_prefix)
  ) {
    return false;
  }
  return meetsFollowRecency(link, source);
}

/**
 * Resolves which discovery source "owns" a URL that matched at least one
 * source's allow_patterns: the source with the lowest match_priority wins
 * (missing match_priority sorts last); ties keep the first source in
 * sources' order. Returns null if the URL matches no source's allow_patterns
 * at all — a per-URL version of the old resolveCandidates(), evaluable the
 * moment a URL is discovered rather than only after every source's crawl has
 * finished, since ownership is a pure function of the URL and the static
 * source configs, not of crawl order or timing.
 */
export function resolveOwnerSourceId(
  url: string,
  sources: readonly DiscoverySource[],
): string | null {
  let winner: { sourceId: string; priority: number } | null = null;

  for (const source of sources) {
    if (!matchesAllowPattern(url, source)) continue;
    const priority = source.match_priority ?? Number.POSITIVE_INFINITY;
    if (!winner || priority < winner.priority) {
      winner = { sourceId: source.id, priority };
    }
  }

  return winner?.sourceId ?? null;
}

/**
 * Runs fn over items with at most `concurrency` calls in flight at once.
 * Used by _crawl_state.ts to fetch/scan one checkpoint batch's worth of URLs
 * concurrently (bounded so a large batch can't spike the edge function's
 * resource limit) while still checkpointing between batches. Results are
 * returned in the same order as items.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}
