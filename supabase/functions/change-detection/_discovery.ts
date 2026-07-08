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

const DEFAULT_MAX_PAGES = 200;

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

// ── Crawl ─────────────────────────────────────────────────────────────────────

/**
 * Crawls a single discovery source starting from its discovery_urls, following
 * same-hostname links up to discovery_depth hops (depth 1 = the discovery_urls
 * page itself; depth 2 = one hop past it, etc.). Returns every link seen on any
 * visited page — allow_pattern filtering happens separately in resolveCandidates
 * so match_priority can be resolved across sources that share a crawl root.
 *
 * Pages within the same depth level are fetched concurrently (fetchPage is
 * expected to serialize actual request *starts* via a shared rate limiter, so
 * this doesn't violate the outbound rate limit — it just lets each request's
 * network round-trip overlap with the others' instead of stacking end to end,
 * which matters once a source's fan-out reaches dozens of pages).
 */
export async function crawlDiscoverySource(
  source: DiscoverySource,
  fetchPage: PageFetcher,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<{ discoveredLinks: Set<string>; errors: CrawlError[] }> {
  const visited = new Set<string>(source.discovery_urls);
  const discoveredLinks = new Set<string>();
  const errors: CrawlError[] = [];
  let level: { url: string; depth: number }[] = source.discovery_urls.map((
    url,
  ) => ({
    url,
    depth: 1,
  }));

  while (level.length > 0 && visited.size <= maxPages) {
    const nextLevel: { url: string; depth: number }[] = [];

    await Promise.all(level.map(async ({ url, depth }) => {
      let page: PageFetchResult;
      try {
        page = await fetchPage(url);
      } catch (e) {
        errors.push({ url, message: (e as Error).message });
        return;
      }

      if (!page.ok) {
        errors.push({ url, message: `HTTP ${page.status}` });
        return;
      }

      for (const link of extractLinks(page.html, url)) {
        discoveredLinks.add(link);

        const isTerminalCandidate = matchesAllowPattern(link, source) ||
          looksLikeDocumentUrl(link);
        if (
          depth < source.discovery_depth &&
          !visited.has(link) &&
          !isTerminalCandidate &&
          sameHostname(link, url) &&
          visited.size < maxPages
        ) {
          visited.add(link);
          nextLevel.push({ url: link, depth: depth + 1 });
        }
      }
    }));

    level = nextLevel;
  }

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
    const { discoveredLinks, errors: sourceErrors } =
      await crawlDiscoverySource(
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
