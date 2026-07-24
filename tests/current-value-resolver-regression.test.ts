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

// Verbatim content of ordinance_provisions Sec. 4-13-2 (transient occupancy tax)
// pulled from Supabase project ahaurkifxzqsrhwjshbj, id
// 019f34b8-6265-754e-9169-b8ad83a1094a (node
// FACOCO_CH4TAFI_ART13TROCTA_S4-13-2LEAMTA). Real content — not hand-authored —
// so it carries the genuine rate-levy language ("imposed and levied a tax
// equivalent to three percent") and the "in addition to the tax imposed by
// subsection" stacking that the levy gate (PR fix ①) requires and that sums to 6%.
const REAL_TOT_S4_13_2_CONTENT =
  "(a) Pursuant to Virginia Code § 58.1-3819, in addition to all other taxes, there is hereby imposed and levied a tax equivalent to three percent of the total room charge paid by or for any such transient for the use or possession of accommodations; provided however, that the tax imposed by this subsection will not be imposed on any transient occupancy in any Lodging Facility that is located within any town that has imposed a tax on transient occupancy. (b) Pursuant to Virginia Code § 58.1-3824, and in addition to the tax imposed by subsection a of this Section, in addition to all other taxes, there is hereby imposed and levied a tax equivalent to two percent of the total room charge paid by or for any such transient for the use or possession of accommodations regardless of whether the hotel is located within any town that has imposed a tax on transient occupancy. The tax imposed pursuant to this subsection will be collected and appropriated for those purposes set forth in Virginia Code § 58.13824. (c) Pursuant to Virginia Code § 58.1-3819, and in addition to the tax imposed by subsections a and b of this Section, in addition to all other taxes, there is hereby imposed and levied a tax equivalent to one percent of the total room charge paid by or for any such transient for the use or possession of accommodations; provided however, that the tax imposed by this subsection will not be imposed on any transient occupancy in any Lodging Facility that is located within any town whose governing body has not consented to the imposition and levy of the tax pursuant to this subsection. The one percent tax levy imposed pursuant to this subsection c shall be designated and spent solely for tourism and travel, marketing of tourism or initiatives that, as determined after consultation with local tourism industry organizations, including representatives of lodging properties located in Fairfax County, attract travelers to Fairfax County, increase occupancy at lodging properties, and generate tourism revenues in Fairfax County. (2-28-72; 1961 Code, § 25-91; 16-04-4; 26-18-4; 20-22-4 ; 09-25-4 .)";

Deno.test("real resolver: current ordinance_provisions wins transient occupancy tax", () => {
  const tot = candidate("ordinance_provisions", "tot-current", {
    document_id: "municode",
    municode_node_id: "FACOCO_CH4TAFI_ART13TROCTA_S4-13-2LEAMTA",
    section_title: "Levy and amount of tax",
    is_current: true,
    effective_date: "2026-04-28",
    content: REAL_TOT_S4_13_2_CONTENT,
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

  // Budget-first ordering (PR fix ②): ordinance anchors now occupy the band
  // BELOW adopted budget_indicators — [2,000,000, 3,000,000) — so an adopted
  // budget rate always outranks them. Asserting the band (not just >= 2M) locks
  // the inversion in place.
  assert(
    score >= 2_000_000 && score < 3_000_000,
    `TOT ordinance must score in the ordinance band [2M, 3M); got ${score}`,
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
    content: REAL_TOT_S4_13_2_CONTENT,
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
