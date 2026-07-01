/**
 * Eval framework types. Categories match the eval suite defined in spec Section 11.
 */

export enum EvalCategory {
  CitationAccuracyNumeric = "citation_accuracy_numeric",
  CitationAccuracyTextual = "citation_accuracy_textual",
  TemporalCorrectness = "temporal_correctness",
  AdversarialNearMiss = "adversarial_near_miss",
  Refusal = "refusal",
  Retrieval = "retrieval",
  Synthesis = "synthesis",
  OutOfCorpus = "out_of_corpus",
}

export type CriterionCheck =
  | { type: "not_refusal" }
  | { type: "is_refusal" }
  | { type: "cites_chunk"; chunk_id: string }
  | { type: "temporal_flag" }
  | { type: "no_temporal_flag" }
  | { type: "answer_contains"; substring: string }
  | { type: "answer_not_contains"; substring: string };

export interface EvalCriterion {
  id: string;
  description: string;
  check: CriterionCheck;
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  query: string;
  chunk_ids: string[];
  criteria: EvalCriterion[];
  notes?: string;
}
