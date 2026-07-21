/**
 * _shared/types.ts — Policy Navigator shared TypeScript types.
 * Query pipeline response assembly types are a draft/planned contract on this
 * branch. The current query-pipeline normal success path still returns interim
 * retrieval data; only the incomplete-search early exit uses QueryResponseData.
 */

/**
 * Canonical structure for individual_votes JSONB column in vote_tallies.
 * LLM extractor (task 2-4) and all query-side readers import this type.
 */
export type VoteValue = "yes" | "no" | "abstain" | "absent";

/** Minimal surface of Supabase.ai.Session used across Edge Functions. */
export interface AiSession {
  run(
    input: string,
    options?: { mean_pool?: boolean; normalize?: boolean },
  ): Promise<number[]>;
}

export interface IndividualVote {
  supervisor_name: string;
  district: string;
  vote: VoteValue;
}

/**
 * Query pipeline planned public API types.
 * These types must remain usable by both backend Edge Functions and frontend —
 * no runtime-specific or framework-specific assumptions.
 */

/** A single retrieved chunk surfaced in the query response. */
export interface CitationChunk {
  chunk_id: string;
  source_url: string;
  source_title: string;
  /** Page number for PDF sources; null for Municode/web sources. */
  page_number: number | null;
  /** Bounding box metadata for PDF sources; null when unavailable. */
  bbox: unknown | null;
  /** ISO 8601 timestamp when the source document was ingested/retrieved. */
  retrieved_at: string | null;
  /** Human-readable citation label, e.g. [Document title, page X, retrieved YYYY-MM-DD]. */
  formatted: string;
  /** Relevance rank (1 = most relevant). */
  rank: number;
}

/** A normalized citation attached to one answer claim. */
export interface CitationMapEntry {
  chunk_id: string;
  /** Page number for PDF sources; null for Municode/web sources. */
  page: number | null;
  /** Bounding box metadata for PDF sources; null when unavailable. */
  bbox: unknown | null;
}

/** Request body sent to the query-pipeline Edge Function. */
export interface QueryRequest {
  /** The user's natural-language question. */
  query: string;
  /** Optional client-supplied session or request context (opaque, not used by the pipeline). */
  context?: Record<string, unknown>;
}

/**
 * Disclosure attached to a response whenever the normal pre-ingested-corpus
 * retrieval found nothing and the query-pipeline attempted the deep-historical
 * slow path instead (see query-pipeline/_deep-historical.ts) — an extended-
 * timeout, live, on-demand fetch against a real external historical archive,
 * rather than either pre-ingesting decades of low-value archive or refusing
 * outright. Always non-null when that slow path was attempted, whether or not
 * it produced an answer, so the UI can disclose why the request took longer
 * and where the answer (or lack of one) came from.
 */
export interface DeepHistoricalDisclosure {
  /** True if the live lookup produced a real, page-cited answer; false if it was attempted but found nothing (never fabricated either way). */
  answered: boolean;
  /** Human-readable label of the archival source consulted, e.g. "Fairfax County Zoning Ordinance — 1945 Reprint (EnCode Archives, live historical lookup)". */
  sourceLabel: string;
  /** Direct URL of the source fetched live for this request — not a chunk from the pre-ingested corpus. */
  sourceUrl: string;
  /** ISO 8601 timestamp of when this live fetch was performed for this request. */
  fetchedAt: string;
}

/** Successful query response data (wrapped in the shared success envelope). */
export interface QueryResponseData {
  /** The generated answer text. */
  answer: string;
  /** Ordered list of cited chunks (highest relevance first). */
  citations: CitationChunk[];
  /** Claim-level citations keyed by exact claim text from the draft answer. */
  citationMap: Record<string, CitationMapEntry>;
  /**
   * Full text of each cited chunk, keyed by chunk_id.
   * Allows the frontend to render chunk text without a second round-trip.
   */
  chunkText: Record<string, string>;
  /** True if the Temporal Judge flagged the answer as time-sensitive or potentially outdated. */
  temporalFlag: boolean;
  /** Non-null if there is a pending code amendment that may affect the answer. */
  amendmentCaveat: string | null;
  /** Non-null if there is a known pending ordinance change relevant to the query. */
  pendingChangeNotice: string | null;
  /** True if retrieval returned fewer candidates than the floor threshold (incomplete search). */
  incompleteSearchWarning: boolean;
  /** ISO 8601 timestamp of the most recently verified source used in the answer. */
  freshnessTimestamp: string | null;
  /** Human-readable freshness notice for the cited sources. */
  freshness: string | null;
  /** All caveats applicable to the assembled answer. */
  caveats: string[];
  /** Non-null only when the deep-historical live-lookup slow path was attempted for this request. */
  deepHistoricalLookup: DeepHistoricalDisclosure | null;
}
