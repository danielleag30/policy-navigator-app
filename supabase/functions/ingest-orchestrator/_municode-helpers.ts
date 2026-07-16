/**
 * Pure decision logic for Municode orphaned-document recovery, split out of
 * municode.ts so it can be unit tested without a live Supabase instance
 * (mirrors the reconciliation/_helpers.ts split for the same reason).
 */

/** Shape of the documents row looked up by canonical URL. */
export interface OrphanDocumentRow {
  status: string;
  municode_resume_state: unknown;
}

export type OrphanRecoveryAction =
  | "insert-fresh"
  | "finalize-only"
  | "rewalk-from-root";

/**
 * Decide how handleMunicode() should proceed when no status='current'
 * document matched the TOC content_hash, but a document row already exists
 * at the canonical Municode URL.
 *
 * This covers the case where a prior invocation's walk fully drained
 * (municode_resume_state cleared) but crashed before index.ts finished
 * embedOrdinanceProvisions()/finalization — documents.status never flipped
 * to 'current'. Without this check, every retry falls through to a fresh
 * INSERT and fails forever on the documents_url_key unique constraint.
 *
 * - No row at this URL yet → proceed with a normal fresh insert.
 * - Row exists but is already 'current', or still holds an in-progress
 *   resume_state (should already have been claimed by
 *   findResumableDocument() before this is ever consulted) → out of scope
 *   for this recovery path; fall back to the pre-fix insert behavior.
 * - Row exists, not 'current', no resume_state, and has provisions written
 *   → the walk already completed; only finalization (embedding + status
 *   flip) needs to run — do NOT restart the walk or insert a duplicate row.
 * - Row exists, not 'current', no resume_state, zero provisions → the prior
 *   attempt crashed before any walk progress; reuse the shell and walk from
 *   the root instead of hard-failing on the unique constraint.
 */
export function classifyOrphanRecovery(
  orphan: OrphanDocumentRow | null,
  provisionCount: number,
): OrphanRecoveryAction {
  if (!orphan) return "insert-fresh";
  if (orphan.status === "current") return "insert-fresh";
  if (orphan.municode_resume_state !== null) return "insert-fresh";
  return provisionCount > 0 ? "finalize-only" : "rewalk-from-root";
}

const HISTORICAL_EMBEDDING_RETRY_MINUTES: Record<number, number> = {
  1: 5,
  2: 15,
  3: 60,
};

export interface HistoricalEmbeddingRetrySchedule {
  attempts: number;
  nextAttemptAt: string;
  lastError: string;
}

export function historicalEmbeddingRetryDelayMinutes(
  nextAttemptNumber: number,
): number {
  return HISTORICAL_EMBEDDING_RETRY_MINUTES[nextAttemptNumber] ?? 6 * 60;
}

export function scheduleHistoricalEmbeddingRetry(
  currentAttempts: number | null | undefined,
  reason: string,
  nowMs: number = Date.now(),
): HistoricalEmbeddingRetrySchedule {
  const attempts = Math.max(0, currentAttempts ?? 0) + 1;
  const delayMinutes = historicalEmbeddingRetryDelayMinutes(attempts);
  return {
    attempts,
    nextAttemptAt: new Date(nowMs + delayMinutes * 60 * 1000).toISOString(),
    lastError: reason,
  };
}

export interface MunicodeJobSummary {
  Id: number | string;
  Name?: string;
  OnlineDate?: string;
}

export interface SelectedHistoricalJob {
  jobId: string;
  name: string;
  supplementNumber: number;
  onlineDate: string;
}

export const DEFAULT_HISTORICAL_SUPPLEMENTS = [
  126,
  127,
  128,
  129,
  130,
  155,
  156,
  157,
  158,
  159,
  160,
  176,
  177,
  178,
] as const;

export const DEFAULT_HISTORICAL_CHAPTER_PREFIXES = [
  "Chapter 4 Article 6",
  "Chapter 9.1",
  "Chapter 9.2",
] as const;

/** Supplements newly walked for EXTENDED_HISTORICAL_CHAPTER_TARGETS below; neither was
 *  already covered by DEFAULT_HISTORICAL_SUPPLEMENTS. */
export const EXTENDED_HISTORICAL_SUPPLEMENTS = [174, 175] as const;

export interface ExtendedHistoricalChapterTarget {
  /** Prefix matched against a top-level (depth-1) TOC node heading, e.g. "Chapter 101". */
  chapterPrefix: string;
  /** When set, the matched chapter's children are fetched and further matched against this
   *  prefix (article-level heading); that child becomes the walk root instead of the whole
   *  chapter. Omit for standalone top-level roots (e.g. "Appendix R"). */
  articlePrefix?: string;
}

/**
 * Supplement-specific chapter/article targets for the DAN-119 follow-up backfill (18
 * additional real amendments found by a 2026-07 audit of all 54 Municode supplements,
 * outside the original Chapter 4 Article 6 / Chapter 9.1 / Chapter 9.2 scope). Unlike
 * DEFAULT_HISTORICAL_CHAPTER_PREFIXES (checked against every DEFAULT_HISTORICAL_SUPPLEMENTS
 * job uniformly), each entry here is keyed by the exact supplement where the pre-amendment
 * text actually lives, so a chapter/article is only walked in the one historical job it
 * applies to instead of the full supplement x chapter cross product.
 */
export const EXTENDED_HISTORICAL_CHAPTER_TARGETS: ReadonlyMap<
  number,
  readonly ExtendedHistoricalChapterTarget[]
> = new Map([
  [178, [
    { chapterPrefix: "Chapter 101", articlePrefix: "Article 2" },
    { chapterPrefix: "Chapter 21", articlePrefix: "Article 1" },
    { chapterPrefix: "Chapter 23", articlePrefix: "Article 1" },
    { chapterPrefix: "Chapter 124.1", articlePrefix: "Article 1" },
    { chapterPrefix: "Chapter 124.1", articlePrefix: "Article 2" },
    { chapterPrefix: "Chapter 124.1", articlePrefix: "Article 6" },
    { chapterPrefix: "Appendix R" },
  ]],
  [177, [
    { chapterPrefix: "Chapter 41.1", articlePrefix: "Article 2" },
    { chapterPrefix: "Chapter 7", articlePrefix: "Article 2" },
    { chapterPrefix: "Chapter 5", articlePrefix: "Article 1" },
  ]],
  [175, [
    { chapterPrefix: "Chapter 12", articlePrefix: "Article 1" },
  ]],
  [174, [
    { chapterPrefix: "Chapter 118", articlePrefix: "Article 1" },
    { chapterPrefix: "Chapter 118", articlePrefix: "Article 2" },
    { chapterPrefix: "Chapter 115", articlePrefix: "Article 4" },
  ]],
]);

export function supplementNumber(name: string | undefined): number | null {
  const match = (name ?? "").match(/\bSupplement\s+(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

export function normalizeOnlineDate(value: string | undefined): string | null {
  if (!value) return null;
  const datePart = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (datePart) return datePart[1];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function selectHistoricalJobs(
  jobs: MunicodeJobSummary[],
  latestJobId: string,
  supplements: readonly number[] = DEFAULT_HISTORICAL_SUPPLEMENTS,
): SelectedHistoricalJob[] {
  const wanted = new Set(supplements);
  return jobs
    .map((job) => {
      const supplement = supplementNumber(job.Name);
      const onlineDate = normalizeOnlineDate(job.OnlineDate);
      if (supplement === null || !onlineDate) return null;
      return {
        jobId: String(job.Id),
        name: job.Name ?? `Supplement ${supplement}`,
        supplementNumber: supplement,
        onlineDate,
      };
    })
    .filter((job): job is SelectedHistoricalJob =>
      job !== null &&
      wanted.has(job.supplementNumber) &&
      job.jobId !== latestJobId
    )
    .sort((a, b) => {
      if (a.onlineDate !== b.onlineDate) {
        return a.onlineDate.localeCompare(b.onlineDate);
      }
      return a.supplementNumber - b.supplementNumber;
    });
}

function normalizeCitationText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Extracts a stable citation key from Municode headings/content. Section-level
 * citations are preferred over chapter-level citations because they survive
 * many node-id churn cases with better precision.
 */
export function extractCitationKey(
  heading: string | null | undefined,
  content: string | null | undefined = undefined,
): string | null {
  const text = normalizeCitationText(`${heading ?? ""} ${content ?? ""}`);

  const section = text.match(
    /(?:§|sec\.?|section)\s*(\d+(?:\.\d+)?-\d+(?:[a-z]|\.\d+|-?\d+)*)\b/i,
  ) ?? text.match(/\b(\d+(?:\.\d+)?-\d+(?:[a-z]|\.\d+|-?\d+)*)\b/i);
  if (section) return `section:${section[1].toLowerCase()}`;

  const chapter = text.match(/\bchapter\s+(\d+(?:\.\d+)?)\b/i);
  if (chapter) return `chapter:${chapter[1].toLowerCase()}`;

  return null;
}

export interface CurrentIdentityRow {
  municode_node_id: string;
  section_title: string | null;
  content?: string | null;
}

export interface CurrentIdentityIndex {
  currentNodeIds: Set<string>;
  citationToCurrentNodeId: Map<string, string>;
  citationToCurrentContent: Map<string, string>;
}

export function buildCurrentIdentityIndex(
  rows: CurrentIdentityRow[],
): CurrentIdentityIndex {
  const currentNodeIds = new Set<string>();
  const citationToCurrentNodeId = new Map<string, string>();
  const citationToCurrentContent = new Map<string, string>();

  for (const row of rows) {
    currentNodeIds.add(row.municode_node_id);
    const key = extractCitationKey(row.section_title, row.content);
    if (key && !citationToCurrentNodeId.has(key)) {
      citationToCurrentNodeId.set(key, row.municode_node_id);
      citationToCurrentContent.set(key, row.content ?? "");
    }
  }

  return { currentNodeIds, citationToCurrentNodeId, citationToCurrentContent };
}

/**
 * Fraction of normalized word tokens (length >= 3, deduped) shared between
 * two texts, as |intersection| / |union|. Used to tell apart two real,
 * distinct scenarios that both produce a citation-number match when a
 * Municode article is renumbered:
 *   - the same provision, amended over time (text mostly unchanged) — should
 *     merge under the current section's identity.
 *   - Municode reassigning a section number to an unrelated new provision
 *     after the old one was renumbered/repealed elsewhere (text unrelated
 *     apart from incidental common words) — merging would misrepresent two
 *     unconnected provisions as one section's history.
 * Calibrated against real Fairfax County ordinance text: genuinely
 * continuing provisions scored 0.83-0.92; genuinely distinct provisions
 * that happened to share a citation number scored 0.11-0.33.
 */
export function contentSimilarity(a: string, b: string): number {
  const tokenize = (text: string): Set<string> =>
    new Set(
      (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) =>
        w.length >= 3
      ),
    );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection++;
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * Minimum contentSimilarity() required before a citation-number match is
 * trusted to merge a historical row into the current section's identity.
 * See contentSimilarity()'s docstring for the calibration data (0.33 highest
 * genuinely-distinct case, 0.60 lowest genuinely-continuing case observed);
 * 0.45 sits in that gap with margin on both sides.
 */
export const CITATION_CONTENT_SIMILARITY_THRESHOLD = 0.45;

export interface HistoricalIdentityInput {
  rawNodeId: string;
  heading: string | null;
  content: string | null;
  currentNodeIds: Set<string>;
  citationToCurrentNodeId: Map<string, string>;
  citationToCurrentContent: Map<string, string>;
}

export interface HistoricalIdentity {
  nodeId: string;
  citationKey: string | null;
  strategy: "raw-current-node" | "citation-current-node" | "historical-node";
}

export function resolveHistoricalIdentity(
  input: HistoricalIdentityInput,
): HistoricalIdentity {
  if (input.currentNodeIds.has(input.rawNodeId)) {
    return {
      nodeId: input.rawNodeId,
      citationKey: extractCitationKey(input.heading, input.content),
      strategy: "raw-current-node",
    };
  }

  const citationKey = extractCitationKey(input.heading, input.content);
  const currentNodeId = citationKey
    ? input.citationToCurrentNodeId.get(citationKey)
    : undefined;
  if (citationKey && currentNodeId) {
    // A shared citation number alone isn't proof of continuity — Municode
    // sometimes reassigns a section number to an unrelated new provision
    // after the old one moved or was repealed. Only trust the match when the
    // text itself is similar enough to be the same provision amended over
    // time; otherwise two unconnected provisions would be merged into one
    // section's (misleading) history. See contentSimilarity()'s docstring.
    const currentContent = input.citationToCurrentContent.get(citationKey) ??
      "";
    const similarity = contentSimilarity(input.content ?? "", currentContent);
    if (similarity >= CITATION_CONTENT_SIMILARITY_THRESHOLD) {
      return {
        nodeId: currentNodeId,
        citationKey,
        strategy: "citation-current-node",
      };
    }
  }

  return {
    nodeId: input.rawNodeId,
    citationKey,
    strategy: "historical-node",
  };
}

export function headingMatchesHistoricalChapter(
  heading: string | null | undefined,
  prefixes: readonly string[] = DEFAULT_HISTORICAL_CHAPTER_PREFIXES,
): boolean {
  const normalized = normalizeCitationText(heading ?? "");
  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizeCitationText(prefix);
    if (!normalized.startsWith(normalizedPrefix)) return false;
    const remainder = normalized.slice(normalizedPrefix.length);
    return remainder === "" || /^[\s.:-]/.test(remainder);
  });
}
