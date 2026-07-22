Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role-key",
);

import type {
  EnrichedCandidate,
  SourceDocument,
} from "../supabase/functions/query-pipeline/index.ts";

const {
  deterministicCurrentValueDraft,
  extractCurrentValueFromOrdinance,
  formatBudgetValue,
  ordinanceCurrentValueScore,
  parseOrdinanceSectionTitle,
  resolveDeterministicCurrentValue,
  structuredCurrentValueScore,
} = await import("../supabase/functions/query-pipeline/index.ts");

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function candidate(
  table: EnrichedCandidate["table"],
  id: string,
  row: Record<string, unknown>,
  rrfScore = 0.01,
): EnrichedCandidate {
  return {
    key: `${table}:${id}`,
    table,
    id,
    row: { id, ...row },
    rankBm25: 1,
    rankVector: null,
    rrfScore,
    ancestors: [],
    municode_node_id: table === "ordinance_provisions"
      ? String(row.municode_node_id ?? id)
      : undefined,
    superseded_date: null,
    hasAmendmentHistory: false,
  };
}

function sourceDocument(
  id: string,
  overrides: Partial<SourceDocument> = {},
): SourceDocument {
  return {
    id,
    url:
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/fy2027-adopted-package.pdf",
    title: "FY2027 Adopted Package",
    filename: "fy2027-adopted-package.pdf",
    ingested_at: "2026-07-12T16:42:04.490Z",
    doc_type: "budget_pdf",
    budget_stage: "adopted",
    source_published_at: null,
    fiscal_year: 2027,
    ...overrides,
  };
}

Deno.test("real resolver: current ordinance_provisions wins transient occupancy tax", () => {
  const tot = candidate("ordinance_provisions", "tot-current", {
    document_id: "municode",
    municode_node_id: "FACOCO_CH4TAFI_ART13TROCTA_S4-13-2LEAMTA",
    section_title: "Levy and amount of tax",
    is_current: true,
    effective_date: "2026-04-28",
    content:
      "Transient occupancy tax levy. There is imposed a tax equivalent to three percent, plus an additional two percent, plus an additional one percent.",
  });

  const query = "what is the current transient occupancy tax rate";
  const score = ordinanceCurrentValueScore(
    query,
    tot,
    sourceDocument("municode", {
      doc_type: "municode_api",
      budget_stage: null,
      fiscal_year: null,
    }),
  );
  const winner = resolveDeterministicCurrentValue(
    query,
    [tot],
    new Map([
      [
        "municode",
        sourceDocument("municode", {
          doc_type: "municode_api",
          budget_stage: null,
          fiscal_year: null,
        }),
      ],
    ]),
  );

  assert(
    score >= 3_000_000,
    "TOT ordinance must receive deterministic ordinance score",
  );
  assertEquals(extractCurrentValueFromOrdinance(query, tot), "6%");
  assertEquals(winner?.id, "tot-current");
});

Deno.test("real resolver: TOT ordinance scores 0 for real estate and personal property queries", () => {
  const tot = candidate("ordinance_provisions", "tot-current", {
    document_id: "municode",
    municode_node_id: "FACOCO_CH4TAFI_ART13TROCTA_S4-13-2LEAMTA",
    section_title: "Levy and amount of tax",
    is_current: true,
    effective_date: "2026-04-28",
    content:
      "Transient occupancy tax levy. There is imposed a tax equivalent to three percent, plus an additional two percent, plus an additional one percent.",
  });
  const doc = sourceDocument("municode", {
    doc_type: "municode_api",
    budget_stage: null,
    fiscal_year: null,
  });

  assertEquals(
    ordinanceCurrentValueScore(
      "what is the current real estate tax rate",
      tot,
      doc,
    ),
    0,
  );
  assertEquals(
    ordinanceCurrentValueScore(
      "what is the current personal property tax rate",
      tot,
      doc,
    ),
    0,
  );
});

Deno.test("real resolver: adopted budget_stage outranks advertised budget indicator", () => {
  const advertised = candidate("budget_indicators", "advertised-rate", {
    document_id: "adv-doc",
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.1225,
    unit: "per $100 of assessed value",
    raw_extracted_text:
      "Real Estate Tax rate 1.1225 per $100 of assessed value",
  }, 0.9);
  const adopted = candidate("budget_indicators", "adopted-rate", {
    document_id: "adopted-doc",
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.12,
    unit: "per $100 of assessed value",
    raw_extracted_text:
      "Adopted Real Estate Tax rate 1.1200 per $100 of assessed value",
  }, 0.1);
  const docs = new Map<string, SourceDocument>([
    [
      "adv-doc",
      sourceDocument("adv-doc", {
        budget_stage: "advertised",
        url:
          "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/advertised/volume%201.pdf",
        title: "FY2027 Advertised Budget",
        filename: "volume 1.pdf",
      }),
    ],
    ["adopted-doc", sourceDocument("adopted-doc")],
  ]);

  assertEquals(
    structuredCurrentValueScore(
      "what is the current real estate tax rate",
      advertised,
      docs.get("adv-doc"),
    ),
    0,
  );
  assert(
    structuredCurrentValueScore(
      "what is the current real estate tax rate",
      adopted,
      docs.get("adopted-doc"),
    ) >= 2_000_000,
    "adopted budget indicator must receive deterministic structured score",
  );

  const winner = resolveDeterministicCurrentValue(
    "what is the current real estate tax rate",
    [advertised, adopted],
    docs,
  );

  assertEquals(winner?.id, "adopted-rate");
  assertEquals(
    formatBudgetValue(winner?.row.value_actual, winner?.row.unit),
    "$1.12 per $100 of assessed value",
  );
});

Deno.test("parseOrdinanceSectionTitle: splits real Municode heading formats into number + heading", () => {
  assertEquals(
    parseOrdinanceSectionTitle("Section 4-13-2. - Levy; amount of tax."),
    { number: "4-13-2", heading: "Levy; amount of tax" },
  );
  assertEquals(
    parseOrdinanceSectionTitle("Sec. 4-6-1. Utility tax imposed."),
    { number: "4-6-1", heading: "Utility tax imposed" },
  );
  assertEquals(
    parseOrdinanceSectionTitle("Chapter 9.2 Cable Television"),
    { number: "9.2", heading: "Cable Television" },
  );
  // No recognized "Section/Sec./Chapter/Article <number>" prefix -> null,
  // so callers can fall back rather than mis-parsing a bare heading.
  assertEquals(parseOrdinanceSectionTitle("Levy and amount of tax"), null);
  assertEquals(parseOrdinanceSectionTitle(null), null);
});

Deno.test("deterministicCurrentValueDraft: TOT ordinance answer is a natural sentence, not a glued heading", () => {
  // Real production section_title shape (see live prod bug report), distinct
  // from the shorter fixture used in the ordinance-winner test above.
  const tot = candidate("ordinance_provisions", "tot-current", {
    document_id: "municode",
    municode_node_id: "FACOCO_CH4TAFI_ART13TROCTA_S4-13-2LEAMTA",
    section_title: "Section 4-13-2. - Levy; amount of tax.",
    is_current: true,
    effective_date: "2026-04-28",
    content:
      "Transient occupancy tax levy. There is imposed a tax equivalent to three percent, plus an additional two percent, plus an additional one percent.",
  });
  const docs = new Map([
    [
      "municode",
      sourceDocument("municode", {
        doc_type: "municode_api",
        title: "Fairfax County Code of Ordinances — Supplement 179",
        budget_stage: null,
        fiscal_year: null,
      }),
    ],
  ]);

  const query = "what is the current transient occupancy tax rate";
  const draft = deterministicCurrentValueDraft(query, tot, docs);

  assert(draft !== null, "expected a deterministic draft for the TOT case");
  const answer = draft!.answer;

  // Still resolves to the correct value and cites the real chunk (no
  // regression on correctness -- this test is about phrasing only).
  assert(answer.includes("6%"), `expected the 6% value in: ${answer}`);
  assert(
    answer.includes("[chunk_id=tot-current;"),
    `expected an inline citation to the real chunk in: ${answer}`,
  );

  // Must NOT reproduce the reported bug: the raw section heading glued
  // directly onto "is <value>" with no connecting words.
  assert(
    !answer.startsWith("Section 4-13-2. - Levy; amount of tax. is"),
    `answer still glues the raw section heading onto the value: ${answer}`,
  );
  assert(
    !answer.includes("tax. is 6%"),
    `answer reads as broken English (heading glued to "is"): ${answer}`,
  );

  // Should read as a real sentence: references the section number
  // naturally and states the value with a verb, not a bare juxtaposition.
  assert(
    /Sec\.\s*4-13-2/.test(answer),
    `expected a natural reference to the section number in: ${answer}`,
  );
  assert(
    /the current value is 6%/i.test(answer),
    `expected a grammatical "the current value is 6%" clause in: ${answer}`,
  );
});
