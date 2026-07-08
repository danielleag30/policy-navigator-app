/**
 * Discovery-based seed crawling for change-detection.
 *
 * Split out from index.ts (which has a top-level Deno.serve() and so isn't
 * safe to import from a test) so the crawl/depth/allow-pattern/match-priority
 * logic can be unit tested against fixture HTML without a live network or
 * database.
 *
 * seed-sources.json mixes two source shapes:
 *   - discovery sources: { discovery_urls, discovery_depth, allow_patterns, ... }
 *     crawled here to find candidate document URLs (board minutes, budget PDFs).
 *   - legacy/API sources: { base_url, url_patterns } (municode_api) — not
 *     crawled, handled directly by index.ts as before.
 */

export type DocType =
  | "budget_pdf"
  | "bos_minutes"
  | "bos_summary"
  | "ordinance"
  | "municode_api";

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
const DEFAULT_MAX_PAGES = 500;

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

function sameHostname(a: string, b: string): boolean {
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
function looksLikeDocumentUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return DOCUMENT_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

/** Extracts a trailing "-YYYY" year from a URL's path, e.g. ".../meeting-march-10-2026" → 2026. */
function trailingYearOf(url: string): number | null {
  try {
    const match = new URL(url).pathname.match(/-(\d{4})$/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function meetsFollowRecency(url: string, source: DiscoverySource): boolean {
  if (source.discovery_follow_min_year === undefined) return true;
  const year = trailingYearOf(url);
  return year === null || year >= source.discovery_follow_min_year;
}

// ── Crawl ─────────────────────────────────────────────────────────────────────

const DEFAULT_CRAWL_CONCURRENCY = 8;

/**
 * Crawls a single discovery source starting from its discovery_urls, following
 * same-hostname links up to discovery_depth hops (depth 1 = the discovery_urls
 * page itself; depth 2 = one hop past it, etc.). Returns every link seen on any
 * visited page — allow_pattern filtering happens separately in resolveCandidates
 * so match_priority can be resolved across sources that share a crawl root.
 *
 * A bounded pool of workers drains a shared queue (fetchPage is expected to
 * additionally serialize actual request *starts* via a shared rate limiter).
 * This overlaps each request's network round-trip with the others' instead of
 * stacking them end to end — but caps how many pages are ever in flight and
 * held in memory at once, which matters once a source's fan-out reaches
 * hundreds of pages (a real county listing page going back 15+ years produced
 * 300+ unique same-host links to follow — firing them all via one unbounded
 * Promise.all tripped this platform's edge-function resource limit).
 *
 * discovery_link_prefix (optional) further restricts which of those
 * same-hostname links get queued for the next depth to ones under a given
 * origin+section, e.g. keeping a source's crawl inside "/budget/" instead of
 * following every shared site-nav link the county's page template repeats on
 * every page (confirmed live: 265 of 381 links found on the
 * budget-committee-meetings listing page are global nav unrelated to any
 * budget content). Cutting those out reduces both the page-fetch count and
 * the queue noise that competes with real meeting pages for maxPages room.
 *
 * discovery_follow_min_year (optional) additionally skips recursing into
 * per-item pages older than a given year, for sources whose listing page
 * covers many more years of dated archive pages than change detection needs
 * to re-verify every run. Cutting those out shrinks not just this crawl but
 * the downstream candidate-scan phase (a HEAD+GET per discovered document,
 * serialized through the shared Fairfax rate limiter) enough to fit the
 * whole invocation inside the edge function's wall-clock budget — confirmed
 * live against budget_committee_meetings: without it, the candidate scan
 * alone for all 89 archived meetings back to 2008 pushed a single invocation
 * past the platform's 150s idle timeout even after discovery_link_prefix
 * removed the earlier WORKER_RESOURCE_LIMIT failure.
 */
export async function crawlDiscoverySource(
  source: DiscoverySource,
  fetchPage: PageFetcher,
  maxPages: number = DEFAULT_MAX_PAGES,
  concurrency: number = DEFAULT_CRAWL_CONCURRENCY,
): Promise<{ discoveredLinks: Set<string>; errors: CrawlError[] }> {
  const visited = new Set<string>(source.discovery_urls);
  const discoveredLinks = new Set<string>();
  const errors: CrawlError[] = [];
  const queue: { url: string; depth: number }[] = source.discovery_urls.map((
    url,
  ) => ({
    url,
    depth: 1,
  }));

  async function worker(): Promise<void> {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const { url, depth } = next;

      let page: PageFetchResult;
      try {
        page = await fetchPage(url);
      } catch (e) {
        errors.push({ url, message: (e as Error).message });
        continue;
      }

      if (!page.ok) {
        errors.push({ url, message: `HTTP ${page.status}` });
        continue;
      }

      for (const link of extractLinks(page.html, url)) {
        discoveredLinks.add(link);

        const isTerminalCandidate = matchesAllowPattern(link, source) ||
          looksLikeDocumentUrl(link);
        const inCrawlScope = source.discovery_link_prefix === undefined ||
          link.startsWith(source.discovery_link_prefix);
        if (
          depth < source.discovery_depth &&
          !visited.has(link) &&
          !isTerminalCandidate &&
          sameHostname(link, url) &&
          inCrawlScope &&
          meetsFollowRecency(link, source) &&
          visited.size < maxPages
        ) {
          visited.add(link);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, () => worker()),
  );

  return { discoveredLinks, errors };
}

/**
 * Resolves final URL → source ownership across all discovery sources' raw
 * crawl results. A URL only becomes a candidate if it matches at least one of
 * its source's allow_patterns; when the same URL matches multiple sources'
 * patterns, the source with the lowest match_priority wins (missing
 * match_priority sorts last). Ties keep the first source in config order.
 */
export function resolveCandidates(
  perSourceLinks: Map<string, Set<string>>,
  sources: DiscoverySource[],
): DiscoveredUrl[] {
  const winners = new Map<
    string,
    { source: DiscoverySource; priority: number }
  >();

  for (const source of sources) {
    const links = perSourceLinks.get(source.id);
    if (!links) continue;

    const priority = source.match_priority ?? Number.POSITIVE_INFINITY;

    for (const link of links) {
      if (!matchesAllowPattern(link, source)) continue;

      const existing = winners.get(link);
      if (!existing || priority < existing.priority) {
        winners.set(link, { source, priority });
      }
    }
  }

  return Array.from(winners.entries()).map(([url, { source }]) => ({
    url,
    docType: source.doc_type,
    sourceId: source.id,
    label: source.label ?? source.doc_type,
  }));
}

/**
 * Runs fn over items with at most `concurrency` calls in flight at once.
 * Same bounded worker-pool shape as crawlDiscoverySource's page fetching —
 * shared here so callers processing a large candidate list (e.g. the
 * change-detection HEAD/GET scan of every discovered URL) get the same
 * protection against unbounded fan-out spiking the edge function's resource
 * usage. Results are returned in the same order as items.
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

/**
 * Crawls every discovery source and resolves the final candidate list.
 * fetchPage is expected to already apply rate limiting and caching — this
 * function calls it once per (source, page) pair it visits, and relies on
 * fetchPage-level memoization to avoid refetching pages shared across sources.
 */
export async function discoverAllCandidates(
  sources: DiscoverySource[],
  fetchPage: PageFetcher,
): Promise<{ candidates: DiscoveredUrl[]; errors: DiscoveryError[] }> {
  const perSourceLinks = new Map<string, Set<string>>();
  const errors: DiscoveryError[] = [];

  await Promise.all(sources.map(async (source) => {
    const { discoveredLinks, errors: sourceErrors } = await crawlDiscoverySource(
      source,
      fetchPage,
    );
    perSourceLinks.set(source.id, discoveredLinks);
    errors.push(
      ...sourceErrors.map((e) => ({
        ...e,
        sourceId: source.id,
        docType: source.doc_type,
      })),
    );
  }));

  return { candidates: resolveCandidates(perSourceLinks, sources), errors };
}
