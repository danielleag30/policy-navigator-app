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
