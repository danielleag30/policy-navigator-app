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

export function supplementNumber(name: string | undefined): number | null {
  const match = (name ?? "").match(/\bSupplement\s+(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

export function normalizeOnlineDate(value: string | undefined): string | null {
  if (!value) return null;
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
}

export function buildCurrentIdentityIndex(
  rows: CurrentIdentityRow[],
): CurrentIdentityIndex {
  const currentNodeIds = new Set<string>();
  const citationToCurrentNodeId = new Map<string, string>();

  for (const row of rows) {
    currentNodeIds.add(row.municode_node_id);
    const key = extractCitationKey(row.section_title, row.content);
    if (key && !citationToCurrentNodeId.has(key)) {
      citationToCurrentNodeId.set(key, row.municode_node_id);
    }
  }

  return { currentNodeIds, citationToCurrentNodeId };
}

export interface HistoricalIdentityInput {
  rawNodeId: string;
  heading: string | null;
  content: string | null;
  currentNodeIds: Set<string>;
  citationToCurrentNodeId: Map<string, string>;
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
  if (currentNodeId) {
    return {
      nodeId: currentNodeId,
      citationKey,
      strategy: "citation-current-node",
    };
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
  return prefixes.some((prefix) =>
    normalized.startsWith(normalizeCitationText(prefix))
  );
}
