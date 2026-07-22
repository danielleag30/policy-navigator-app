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
  extractCurrentValueFromOrdinance,
  formatBudgetValue,
  ordinanceCurrentValueScore,
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
      "Transient occupancy tax levy. There is imposed a tax of 3 percent, plus an additional 2 percent, plus an additional 1 percent.",
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

  assert(score >= 3_000_000, "TOT ordinance must receive deterministic ordinance score");
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
      "Transient occupancy tax levy. There is imposed a tax of 3 percent, plus an additional 2 percent, plus an additional 1 percent.",
  });
  const doc = sourceDocument("municode", {
    doc_type: "municode_api",
    budget_stage: null,
    fiscal_year: null,
  });

  assertEquals(
    ordinanceCurrentValueScore("what is the current real estate tax rate", tot, doc),
    0,
  );
  assertEquals(
    ordinanceCurrentValueScore("what is the current personal property tax rate", tot, doc),
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
    raw_extracted_text: "Real Estate Tax rate 1.1225 per $100 of assessed value",
  }, 0.9);
  const adopted = candidate("budget_indicators", "adopted-rate", {
    document_id: "adopted-doc",
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.12,
    unit: "per $100 of assessed value",
    raw_extracted_text: "Adopted Real Estate Tax rate 1.1200 per $100 of assessed value",
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
