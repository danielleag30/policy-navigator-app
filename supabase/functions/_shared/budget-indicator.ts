export function canonicalizeBudgetIndicatorName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  const withoutStage = trimmed
    .replace(/^(?:fy\s*)?20\d{2}\s+/i, "")
    .replace(/^(?:adopted|advertised|approved|current|proposed|draft)\s+/i, "")
    .replace(/\s+(?:adopted|advertised|approved|current|proposed|draft)$/i, "")
    .trim();
  const normalized = withoutStage.toLowerCase().replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (
    /\breal estate\b/.test(normalized) && /\btax\b/.test(normalized) &&
    /\brate\b/.test(normalized)
  ) {
    return "Real Estate Tax rate";
  }
  if (
    /\bpersonal property\b/.test(normalized) && /\btax\b/.test(normalized) &&
    /\brate\b/.test(normalized)
  ) {
    return "Personal Property Tax rate";
  }
  if (
    (/\btransient occupancy\b/.test(normalized) ||
      /\btot\b/.test(normalized)) &&
    /\btax\b/.test(normalized) && /\brate\b/.test(normalized)
  ) {
    return "Transient Occupancy Tax rate";
  }

  return withoutStage || trimmed;
}

export interface BudgetIndicatorEmbeddingInputRow {
  fiscal_year: number | string | null;
  department?: string | null;
  program?: string | null;
  indicator_name: string | null;
  value_actual?: number | string | null;
  value_target?: number | string | null;
  value_prior_year?: number | string | null;
  unit?: string | null;
  effective_date?: string | null;
  effective_date_source?: string | null;
  chunk_sequence?: number | string | null;
  budget_stage?: string | null;
  documents?: { budget_stage?: string | null } | null;
}

function fieldValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "null";
  if (typeof value === "number") return Number.isFinite(value) ? `${value}` : "null";
  return String(value).trim().replace(/\s+/g, " ") || "null";
}

/**
 * Embedding-only representation for budget_indicators.
 *
 * This intentionally uses only structured database columns extracted for this
 * exact row. It does not include raw_extracted_text, because sibling rows often
 * share that same source blob and would otherwise receive identical vectors.
 * The source/citation text remains raw_extracted_text in the row itself.
 */
export function budgetIndicatorEmbeddingInput(
  row: BudgetIndicatorEmbeddingInputRow,
): string {
  const budgetStage = row.budget_stage ?? row.documents?.budget_stage ?? null;

  return [
    "budget_indicator",
    `indicator_name: ${fieldValue(row.indicator_name)}`,
    `value_actual: ${fieldValue(row.value_actual)}`,
    `value_target: ${fieldValue(row.value_target)}`,
    `value_prior_year: ${fieldValue(row.value_prior_year)}`,
    `unit: ${fieldValue(row.unit)}`,
    `fiscal_year: ${fieldValue(row.fiscal_year)}`,
    `budget_stage: ${fieldValue(budgetStage)}`,
    `department: ${fieldValue(row.department)}`,
    `program: ${fieldValue(row.program)}`,
    `effective_date: ${fieldValue(row.effective_date)}`,
    `effective_date_source: ${fieldValue(row.effective_date_source)}`,
    `chunk_sequence: ${fieldValue(row.chunk_sequence)}`,
  ].join("\n");
}
