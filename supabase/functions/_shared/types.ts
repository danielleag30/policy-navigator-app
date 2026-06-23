/**
 * _shared/types.ts — Policy Navigator shared TypeScript types.
 * Verified by task 2-21b against actual Edge Function implementations.
 *
 * CHANGES (task 2-21b):
 * - QueryResponseData fields confirmed correct against query-pipeline/index.ts.
 * - chunkText keyed by chunk_id: verified (used in the INCOMPLETE_SEARCH_FLOOR
 *   early-exit path; will be populated by tasks 2-8 through 2-13).
 * - CitationChunk fields (chunk_id, source_url, source_title, page_number, rank):
 *   consistent with the planned citation assembly step (tasks 2-8 through 2-13).
 *   Not yet emitted by the pipeline (retrieval only is implemented as of 2-21b).
 * - Divergence: the current "normal success" response of query-pipeline returns
 *   { candidates: EnrichedCandidate[], total: number } (task 2-7 interim output)
 *   rather than QueryResponseData. That interim shape is internal to the function
 *   and is NOT exported here — it will be replaced once generation is wired in.
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
 * Query pipeline public API types (verified by task 2-21b).
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
  /** Relevance rank (1 = most relevant). */
  rank: number;
}

/** Request body sent to the query-pipeline Edge Function. */
export interface QueryRequest {
  /** The user's natural-language question. */
  query: string;
  /** Optional client-supplied session or request context (opaque, not used by the pipeline). */
  context?: Record<string, unknown>;
}

/** Successful query response data (wrapped in the shared success envelope). */
export interface QueryResponseData {
  /** The generated answer text. */
  answer: string;
  /** Ordered list of cited chunks (highest relevance first). */
  citations: CitationChunk[];
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
}
