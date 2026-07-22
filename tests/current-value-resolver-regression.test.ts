type Table = "budget_indicators" | "narrative_chunks" | "ordinance_provisions";

interface Candidate {
  table: Table;
  id: string;
  rrfScore: number;
  row: Record<string, unknown>;
}

interface Doc {
  budget_stage?: "advertised" | "adopted" | null;
  fiscal_year?: number | null;
}

function normalizedText(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/(?<=\d),(?=\d)/g, "").replace(
      /[^a-z0-9]+/g,
      " ",
    ).trim()
    : "";
}

function text(c: Candidate): string {
  return String(c.row.raw_extracted_text ?? c.row.content ?? "");
}

function formatBudgetValue(value: unknown, unit: unknown): string | null {
  if (typeof value !== "number") return null;
  const unitText = typeof unit === "string" ? unit : "";
  return unitText ? `${value} ${unitText}` : String(value);
}

function matchesSubject(query: string, c: Candidate): boolean {
  const corpus = [
    c.row.indicator_name,
    c.row.program,
    c.row.department,
    text(c),
  ].map(normalizedText).join(" ");
  return query.toLowerCase().split(/[^a-z0-9]+/).filter((t) =>
    t.length > 2 && !["what", "current", "the", "rate", "tax", "is"].includes(t)
  ).every((term) => corpus.includes(term));
}

function extractOrdinanceValue(query: string, c: Candidate): string | null {
  if (c.table !== "ordinance_provisions" || c.row.is_current !== true) {
    return null;
  }
  if (!matchesSubject(query, c)) return null;
  const percentages = [
    ...text(c).matchAll(/\b(\d+(?:\.\d+)?)\s*(?:%|percent)\b/gi),
  ]
    .map((m) => Number(m[1]));
  const unique = [...new Set(percentages)];
  if (unique.length < 2) return null;
  const total = unique.reduce((sum, value) => sum + value, 0);
  return `${total}%`;
}

function score(query: string, c: Candidate, doc?: Doc): number {
  if (c.table === "ordinance_provisions") {
    return extractOrdinanceValue(query, c) === null ? 0 : 3_000_000;
  }
  if (c.table === "budget_indicators") {
    if (!matchesSubject(query, c)) return 0;
    if (doc?.budget_stage !== "adopted") return 0;
    const fy = Number(c.row.fiscal_year ?? doc?.fiscal_year ?? 0);
    return 2_000_000 + fy;
  }
  return 0;
}

function resolve(
  query: string,
  candidates: Candidate[],
  docs: Map<string, Doc>,
): Candidate | null {
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: score(
        query,
        candidate,
        docs.get(String(candidate.row.document_id)),
      ),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) =>
      b.score - a.score || b.candidate.rrfScore - a.candidate.rrfScore
    );
  return scored[0]?.candidate ?? null;
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("current ordinance_provisions wins transient occupancy tax end-to-end precheck", () => {
  const candidate: Candidate = {
    table: "ordinance_provisions",
    id: "FACOCO_CH4TAFI_ART13TROCTA_S4-13-2LEAMTA",
    rrfScore: 0.001,
    row: {
      document_id: "municode",
      is_current: true,
      effective_date: "2026-04-28",
      content:
        "Transient occupancy tax levy. There is imposed a tax of 3 percent, plus an additional 2 percent, plus an additional 1 percent.",
    },
  };

  const winner = resolve(
    "what is the current transient occupancy tax rate",
    [candidate],
    new Map([["municode", {}]]),
  );

  assertEquals(winner?.id, "FACOCO_CH4TAFI_ART13TROCTA_S4-13-2LEAMTA");
  assertEquals(
    extractOrdinanceValue("current transient occupancy tax rate", candidate),
    "6%",
  );
});

Deno.test("advertised budget_stage does not outrank adopted even with higher RRF", () => {
  const advertised: Candidate = {
    table: "budget_indicators",
    id: "advertised",
    rrfScore: 0.9,
    row: {
      document_id: "adv",
      fiscal_year: 2027,
      indicator_name: "Real Estate Tax rate",
      value_actual: 1.1225,
      unit: "per $100 of assessed value",
      raw_extracted_text: "Real Estate Tax rate 1.1225 per $100",
    },
  };
  const adopted: Candidate = {
    ...advertised,
    id: "adopted",
    rrfScore: 0.1,
    row: {
      ...advertised.row,
      document_id: "adopt",
      value_actual: 1.12,
      raw_extracted_text: "Adopted Real Estate Tax rate 1.1200 per $100",
    },
  };

  const winner = resolve(
    "what is the current real estate tax rate",
    [advertised, adopted],
    new Map([
      ["adv", { budget_stage: "advertised", fiscal_year: 2027 }],
      ["adopt", { budget_stage: "adopted", fiscal_year: 2027 }],
    ]),
  );

  assertEquals(winner?.id, "adopted");
  assertEquals(
    formatBudgetValue(winner?.row.value_actual, winner?.row.unit),
    "1.12 per $100 of assessed value",
  );
});
