/**
 * Tests for the amendment-resolution Edge Function.
 *
 * Covers: citation/keyword extraction, candidate ranking, LLM result parsing
 * and anti-fabrication guards, the accept/reject decision, and the
 * amendment_events/pending_code_changes row builders (pure functions only —
 * DB/Ollama integration requires a live Supabase instance and is not covered
 * here, same convention as tests/reconciliation.test.ts).
 */

import {
  buildAmendmentEventRow,
  buildPendingCodeChangeRow,
  extractCitationTokens,
  extractKeywords,
  matchesCitation,
  type OrdinanceCandidate,
  parseResolutionLlmResult,
  pickVerifiedVoteTally,
  type PolicyDecisionForResolution,
  rankAndCapCandidates,
  resolveEffectiveDate,
  shouldAcceptResolution,
  type VoteTallyCandidate,
} from "../supabase/functions/amendment-resolution/_helpers.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function makeDecision(
  overrides: Partial<PolicyDecisionForResolution> = {},
): PolicyDecisionForResolution {
  return {
    id: "dec-1",
    document_id: "doc-1",
    meeting_date: "2000-04-24",
    decision_type: "fee_schedule",
    subject:
      "Amendment to Code of the County of Fairfax, Chapter 67.1 to revise sewer service charges",
    effective_date: null,
    raw_extracted_text: "Chapter 67.1 sewer service charge text...",
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<OrdinanceCandidate> = {},
): OrdinanceCandidate {
  return {
    id: "cand-1",
    municode_node_id:
      "FACOCO_CH67.1SASESEDI_ART10CH_S67.1-10-2AVCOLASPSECHBACHHAWACH",
    section_title: "Service Charges",
    content: "Sewer service charges are established as follows...",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractCitationTokens
// ---------------------------------------------------------------------------

Deno.test("extractCitationTokens: extracts a plain chapter number", () => {
  const tokens = extractCitationTokens("Chapter 4 (Taxation and Finance)");
  assertEquals(tokens, ["CH4"]);
});

Deno.test("extractCitationTokens: extracts a decimal chapter number", () => {
  const tokens = extractCitationTokens(
    "amendments to Chapter 67.1 sewer charges",
  );
  assertEquals(tokens, ["CH67.1"]);
});

Deno.test("extractCitationTokens: extracts an appendix roman numeral", () => {
  const tokens = extractCitationTokens("Appendix I (Special Service District)");
  assertEquals(tokens, ["APXI"]);
});

Deno.test("extractCitationTokens: extracts multiple distinct tokens, deduped", () => {
  const tokens = extractCitationTokens(
    "See Chapter 4 and also Chapter 4 again, and Appendix I",
  );
  assertEquals(tokens, ["CH4", "APXI"]);
});

Deno.test("extractCitationTokens: no citations present returns empty array", () => {
  const tokens = extractCitationTokens(
    "Approval of Supplemental Appropriation Resolution AS 97060",
  );
  assertEquals(tokens, []);
});

// ---------------------------------------------------------------------------
// matchesCitation
// ---------------------------------------------------------------------------

Deno.test("matchesCitation: true when node_id contains a token", () => {
  assert(
    matchesCitation("FACOCO_CH67.1SASESEDI_ART1", ["CH67.1"]),
    "should match",
  );
});

Deno.test("matchesCitation: false when no tokens match", () => {
  assert(
    !matchesCitation("FACOCO_CH4TAFI", ["CH67.1", "APXI"]),
    "should not match",
  );
});

Deno.test("matchesCitation: false when token list is empty", () => {
  assert(!matchesCitation("FACOCO_CH4TAFI", []), "empty tokens never match");
});

// ---------------------------------------------------------------------------
// extractKeywords
// ---------------------------------------------------------------------------

Deno.test("extractKeywords: drops stopwords and short words", () => {
  const kws = extractKeywords(
    "Approval of the Adoption of Amendments to the Code",
  );
  assertEquals(kws, []);
});

Deno.test("extractKeywords: keeps distinctive words, longest first", () => {
  const kws = extractKeywords(
    "Decrease Gypsy Moth Infestation tax rate for Special Service District",
  );
  assert(kws.includes("gypsy"), "should include gypsy");
  assert(kws.includes("infestation"), "should include infestation");
  assert(kws.includes("district"), "should include district");
  assert(
    kws[0].length >= kws[kws.length - 1].length,
    "should be ordered longest-first",
  );
});

Deno.test("extractKeywords: dedupes repeated words", () => {
  const kws = extractKeywords("sewer sewer sewer charges");
  assertEquals(kws.filter((w) => w === "sewer").length, 1);
});

Deno.test("extractKeywords: respects max cap", () => {
  const kws = extractKeywords(
    "gypsy moth infestation sewer availability charges wastewater pretreatment discharge",
    3,
  );
  assertEquals(kws.length, 3);
});

// ---------------------------------------------------------------------------
// rankAndCapCandidates
// ---------------------------------------------------------------------------

Deno.test("rankAndCapCandidates: narrows to citation matches when present", () => {
  const candidates = [
    makeCandidate({
      id: "a",
      municode_node_id: "FACOCO_CH67.1SASESEDI_ART10CH_S67.1-10-2",
    }),
    makeCandidate({
      id: "b",
      municode_node_id: "FACOCO_CH4TAFI_ART10BITAREPR_S4-10-1",
    }),
  ];
  const ranked = rankAndCapCandidates(candidates, ["CH67.1"], 8);
  assertEquals(ranked.length, 1);
  assertEquals(ranked[0].id, "a");
});

Deno.test("rankAndCapCandidates: falls back to full deduped list when no citation match", () => {
  const candidates = [
    makeCandidate({ id: "a", municode_node_id: "FACOCO_CH4TAFI" }),
    makeCandidate({ id: "b", municode_node_id: "FACOCO_CH12TEANRE" }),
  ];
  const ranked = rankAndCapCandidates(candidates, ["CH67.1"], 8);
  assertEquals(ranked.length, 2);
});

Deno.test("rankAndCapCandidates: dedupes by id", () => {
  const candidates = [
    makeCandidate({ id: "a" }),
    makeCandidate({ id: "a" }),
    makeCandidate({ id: "b", municode_node_id: "FACOCO_CH4TAFI" }),
  ];
  const ranked = rankAndCapCandidates(candidates, [], 8);
  assertEquals(ranked.length, 2);
});

Deno.test("rankAndCapCandidates: enforces cap", () => {
  const candidates = Array.from(
    { length: 20 },
    (_, i) => makeCandidate({ id: `c${i}`, municode_node_id: `FACOCO_CH${i}` }),
  );
  const ranked = rankAndCapCandidates(candidates, [], 5);
  assertEquals(ranked.length, 5);
});

// ---------------------------------------------------------------------------
// parseResolutionLlmResult
// ---------------------------------------------------------------------------

const VALID_IDS = new Set([
  "FACOCO_CH67.1SASESEDI_ART10CH_S67.1-10-2AVCOLASPSECHBACHHAWACH",
]);

Deno.test("parseResolutionLlmResult: accepts a valid high-confidence match", () => {
  const result = parseResolutionLlmResult(
    JSON.stringify({
      matched: true,
      municode_node_id:
        "FACOCO_CH67.1SASESEDI_ART10CH_S67.1-10-2AVCOLASPSECHBACHHAWACH",
      confidence: "high",
      notes: "Directly amends this sewer service charge section.",
    }),
    VALID_IDS,
  );
  assertEquals(result.matched, true);
  assertEquals(result.confidence, "high");
  assertEquals(
    result.municode_node_id,
    "FACOCO_CH67.1SASESEDI_ART10CH_S67.1-10-2AVCOLASPSECHBACHHAWACH",
  );
});

Deno.test("parseResolutionLlmResult: rejects a matched=false response", () => {
  const result = parseResolutionLlmResult(
    JSON.stringify({
      matched: false,
      municode_node_id: null,
      confidence: "low",
      notes: "No clear match.",
    }),
    VALID_IDS,
  );
  assertEquals(result.matched, false);
  assertEquals(result.municode_node_id, null);
});

Deno.test("parseResolutionLlmResult: downgrades a fabricated/hallucinated node_id even when matched=true", () => {
  const result = parseResolutionLlmResult(
    JSON.stringify({
      matched: true,
      municode_node_id: "FACOCO_MADE_UP_NODE_ID",
      confidence: "high",
      notes: "Looks right.",
    }),
    VALID_IDS,
  );
  assertEquals(
    result.matched,
    false,
    "must never trust a node_id outside the candidate list",
  );
  assertEquals(result.municode_node_id, null);
  assert(
    result.notes.includes("not in the candidate list"),
    "should explain the rejection",
  );
});

Deno.test("parseResolutionLlmResult: invalid confidence value falls back to low", () => {
  const result = parseResolutionLlmResult(
    JSON.stringify({
      matched: true,
      municode_node_id:
        "FACOCO_CH67.1SASESEDI_ART10CH_S67.1-10-2AVCOLASPSECHBACHHAWACH",
      confidence: "very sure",
      notes: "x",
    }),
    VALID_IDS,
  );
  assertEquals(result.confidence, "low");
});

Deno.test("parseResolutionLlmResult: unparsable content returns matched=false", () => {
  const result = parseResolutionLlmResult("not json at all", VALID_IDS);
  assertEquals(result.matched, false);
  assertEquals(result.municode_node_id, null);
});

Deno.test("parseResolutionLlmResult: JSON embedded in prose is extracted", () => {
  const content = `Sure thing! ${
    JSON.stringify({
      matched: true,
      municode_node_id:
        "FACOCO_CH67.1SASESEDI_ART10CH_S67.1-10-2AVCOLASPSECHBACHHAWACH",
      confidence: "high",
      notes: "match",
    })
  } Done.`;
  const result = parseResolutionLlmResult(content, VALID_IDS);
  assertEquals(result.matched, true);
});

// ---------------------------------------------------------------------------
// shouldAcceptResolution — "can't confidently resolve, correctly skips"
// ---------------------------------------------------------------------------

Deno.test("shouldAcceptResolution: accepts matched + high confidence + node_id present", () => {
  assert(
    shouldAcceptResolution({
      matched: true,
      municode_node_id: "node-1",
      confidence: "high",
      notes: "",
    }),
    "should accept",
  );
});

Deno.test("shouldAcceptResolution: rejects medium confidence even when matched", () => {
  assert(
    !shouldAcceptResolution({
      matched: true,
      municode_node_id: "node-1",
      confidence: "medium",
      notes: "",
    }),
    "medium confidence must not be accepted",
  );
});

Deno.test("shouldAcceptResolution: rejects low confidence", () => {
  assert(
    !shouldAcceptResolution({
      matched: true,
      municode_node_id: "node-1",
      confidence: "low",
      notes: "",
    }),
    "low confidence must not be accepted",
  );
});

Deno.test("shouldAcceptResolution: rejects matched=false regardless of confidence", () => {
  assert(
    !shouldAcceptResolution({
      matched: false,
      municode_node_id: null,
      confidence: "high",
      notes: "",
    }),
    "unmatched must not be accepted",
  );
});

// ---------------------------------------------------------------------------
// pickVerifiedVoteTally — never blindly trust policy_decisions.vote_tally_id
// ---------------------------------------------------------------------------

function makeVote(id: string, motion_text: string): VoteTallyCandidate {
  return { id, motion_text };
}

Deno.test("pickVerifiedVoteTally: regression — real production case (Gypsy Moth / Appendix I) picks the correct vote among 3 unrelated votes on the same document, not the adjacent one", () => {
  // These are the real 1993-04-22 document's 3 vote_tallies rows. The bug:
  // policy_decisions.vote_tally_id pointed at the Girl Scout proclamation
  // (extraction-time chunk adjacency), not the actual amendment vote.
  const girlScoutVote = makeVote(
    "vote-girlscout",
    'Proclamation designating "GIRL SCOUT LEADER\'S DAY"',
  );
  const gypsyMothVote = makeVote(
    "vote-gypsymoth",
    "Amendment to the Code of the County of Fairfax, Appendix I, Fairfax County Special Service District for the Control of Gypsy Moth Infestations, Section 5, to reduce tax rate",
  );
  const sarVote = makeVote(
    "vote-sar",
    "Approval of Supplemental Appropriation Resolution (SAR) AS 93054 and Amendment to the Fiscal Planning Resolution (FPR) AS 93905",
  );

  const decisionSubject =
    "Reduction of tax rate for Fairfax County Special Service District for the Control of Gypsy Moth Infestations";
  const decisionText =
    "ADOPTION OF A PROPOSED AMENDMENT TO THE CODE OF THE COUNTY OF FAIRFAX, APPENDIX I, FAIRFAX COUNTY SPECIAL SERVICE DISTRICT FOR THE CONTROL OF GYPSY MOTH INFESTATIONS, SECTION 5, TO REDUCE ITS TAX RATE";

  const citationTokens = extractCitationTokens(
    `${decisionSubject} ${decisionText}`,
  );
  const keywords = extractKeywords(decisionSubject);

  const result = pickVerifiedVoteTally(
    [girlScoutVote, gypsyMothVote, sarVote],
    keywords,
    citationTokens,
  );

  assertEquals(
    result.vote_tally_id,
    "vote-gypsymoth",
    "must pick the actual amendment vote, not the adjacent proclamation the extractor linked",
  );
  assertEquals(result.matched_via, "citation");
});

Deno.test("pickVerifiedVoteTally: a unique citation match wins outright", () => {
  const result = pickVerifiedVoteTally(
    [
      makeVote("a", "Some unrelated proclamation"),
      makeVote("b", "Amendment to Chapter 67.1 sewer service charges"),
    ],
    ["sewer"],
    ["CH67.1"],
  );
  assertEquals(result.vote_tally_id, "b");
  assertEquals(result.matched_via, "citation");
});

Deno.test("pickVerifiedVoteTally: multiple citation matches fall back to a keyword tiebreak", () => {
  const result = pickVerifiedVoteTally(
    [
      makeVote("a", "Chapter 67.1 sewer service charges revision"),
      makeVote("b", "Chapter 67.1 general housekeeping cleanup"),
    ],
    ["sewer"],
    ["CH67.1"],
  );
  assertEquals(result.vote_tally_id, "a");
  assertEquals(result.matched_via, "keyword");
});

Deno.test("pickVerifiedVoteTally: keyword scoring picks the clear leader when there's no citation", () => {
  const result = pickVerifiedVoteTally(
    [
      makeVote("a", "Proclamation for volunteer week"),
      makeVote("b", "Gypsy Moth Infestation special service district tax rate"),
    ],
    ["gypsy", "moth", "infestation", "district"],
    [],
  );
  assertEquals(result.vote_tally_id, "b");
  assertEquals(result.matched_via, "keyword");
});

Deno.test("pickVerifiedVoteTally: a tied keyword score is ambiguous and returns no match", () => {
  const result = pickVerifiedVoteTally(
    [
      makeVote("a", "Gypsy Moth control district"),
      makeVote("b", "Gypsy Moth infestation program"),
    ],
    ["gypsy", "moth"],
    [],
  );
  assertEquals(result.vote_tally_id, null, "a tie must never be guessed");
});

Deno.test("pickVerifiedVoteTally: zero keyword overlap returns no match", () => {
  const result = pickVerifiedVoteTally(
    [makeVote("a", "Unrelated proclamation about a parade")],
    ["gypsy", "moth", "infestation"],
    [],
  );
  assertEquals(result.vote_tally_id, null);
});

Deno.test("pickVerifiedVoteTally: no candidates on the document returns no match", () => {
  const result = pickVerifiedVoteTally([], ["gypsy"], ["CH67.1"]);
  assertEquals(result.vote_tally_id, null);
  assertEquals(result.matched_via, null);
});

// ---------------------------------------------------------------------------
// resolveEffectiveDate
// ---------------------------------------------------------------------------

Deno.test("resolveEffectiveDate: uses decision effective_date with bos_summary source when present", () => {
  const result = resolveEffectiveDate({
    effective_date: "2004-07-01",
    meeting_date: "2004-03-08",
  });
  assertEquals(result, {
    effective_date: "2004-07-01",
    effective_date_source: "bos_summary",
  });
});

Deno.test("resolveEffectiveDate: falls back to meeting_date with default source when null", () => {
  const result = resolveEffectiveDate({
    effective_date: null,
    meeting_date: "2000-04-24",
  });
  assertEquals(result, {
    effective_date: "2000-04-24",
    effective_date_source: "default",
  });
});

// ---------------------------------------------------------------------------
// buildAmendmentEventRow / buildPendingCodeChangeRow — the write path
// ---------------------------------------------------------------------------

Deno.test("buildAmendmentEventRow: builds the exact shape reconciliation/pending_code_changes expect", () => {
  const decision = makeDecision();
  const row = buildAmendmentEventRow(
    decision,
    "FACOCO_CH67.1SASESEDI_ART10CH_S67.1-10-2AVCOLASPSECHBACHHAWACH",
    "verified-vote-1",
    "event-1",
  );

  assertEquals(row.id, "event-1");
  assertEquals(
    row.municode_node_id,
    "FACOCO_CH67.1SASESEDI_ART10CH_S67.1-10-2AVCOLASPSECHBACHHAWACH",
  );
  assertEquals(row.adopted_date, "2000-04-24");
  assertEquals(row.effective_date, "2000-04-24"); // decision.effective_date was null -> falls back
  assertEquals(row.effective_date_source, "default");
  assertEquals(row.vote_tally_id, "verified-vote-1");
  assertEquals(row.document_id, "doc-1");
  assertEquals(row.ordinance_number, null);
  assertEquals(row.resolution_number, null);
});

Deno.test("buildAmendmentEventRow: throws rather than fabricating a vote_tally_id when the verified id is null", () => {
  const decision = makeDecision();
  let threw = false;
  try {
    buildAmendmentEventRow(decision, "some-node", null, "event-1");
  } catch {
    threw = true;
  }
  assert(threw, "must refuse to build a row without a verified vote_tally_id");
});

Deno.test("buildPendingCodeChangeRow: builds a 'pending' row referencing the amendment event", () => {
  const decision = makeDecision({ effective_date: "2001-01-01" });
  const row = buildPendingCodeChangeRow(decision, "node-x", "event-1", "pcc-1");

  assertEquals(row.id, "pcc-1");
  assertEquals(row.municode_node_id, "node-x");
  assertEquals(row.codification_status, "pending");
  assertEquals(row.amendment_event_id, "event-1");
  assertEquals(row.document_id, "doc-1");
  assertEquals(row.effective_date, "2001-01-01");
  assertEquals(row.effective_date_source, "bos_summary");
  assertEquals(row.codified_at, null);
  assertEquals(row.on_spot_edits, null);
  assertEquals(row.proposed_text, decision.raw_extracted_text);
});
