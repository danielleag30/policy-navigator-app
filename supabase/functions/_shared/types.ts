/**
 * _shared/types.ts — Policy Navigator shared TypeScript types.
 * Query pipeline types are a DRAFT (task 2-21a); final verification is task 2-21b.
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
 * Query pipeline public API types — DRAFT (v1).
 * This is an early draft subject to revision during implementation.
 * Final verification is task 2-21b.
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
}
