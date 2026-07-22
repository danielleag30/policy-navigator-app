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
