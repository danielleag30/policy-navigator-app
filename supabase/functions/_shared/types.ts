/**
 * Canonical structure for individual_votes JSONB column in vote_tallies.
 * LLM extractor (task 2-4) and all query-side readers import this type.
 */
export type VoteValue = 'yes' | 'no' | 'abstain' | 'absent';

export interface IndividualVote {
  supervisor_name: string;
  district: string;
  vote: VoteValue;
}
