/**
 * Unit tests for the RRF merge logic and rate-limit helpers in query-pipeline.
 *
 * Run with:  deno test supabase/functions/query-pipeline/rrf_test.ts
 */

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role-key",
);

const {
  deterministicCurrentValueDraft,
  extractCurrentValueFromNarrative,
  extractCurrentValueFromOrdinance,
  filterUncurrentNarrativeValues,
  formatInlineAnswerCitations,
  formatBudgetValue,
  narrativeCurrentValueHasStaleProvenance,
  narrativeMakesCurrentValueClaim,
  resolveDeterministicCurrentValue,
  selectCurrentOrdinanceValueAnchors,
  structuredCurrentValueScore,
} = await import("./index.ts");

// ── Local harness for RRF and response-assembly tests ────────────────────────

const RRF_K = 60;
const JUDGE_OUTPUT_LIMIT = 8;

type ChunkTable =
  | "ordinance_provisions"
  | "vote_tallies"
  | "policy_decisions"
  | "budget_indicators"
  | "narrative_chunks";

const CHUNK_TABLES: ChunkTable[] = [
  "ordinance_provisions",
  "vote_tallies",
  "policy_decisions",
  "budget_indicators",
  "narrative_chunks",
];

interface RankedCandidate {
  key: string;
  table: ChunkTable;
  id: string;
  row: Record<string, unknown>;
  rankBm25: number | null;
  rankVector: number | null;
  rrfScore: number;
}

interface EnrichedCandidate extends RankedCandidate {
  ancestors: Array<
    { municode_node_id: string; title: string; node_depth: number }
  >;
  municode_node_id: string | undefined;
  superseded_date: string | null;
  hasAmendmentHistory: boolean;
}

interface SourceDocument {
  id: string;
  url: string;
  title: string | null;
  filename: string | null;
  ingested_at: string;
  doc_type: string | null;
  source_published_at: string | null;
  fiscal_year: number | null;
  budget_stage?: "advertised" | "adopted" | null;
}

function rrfMerge(
  bm25Results: Map<ChunkTable, Record<string, unknown>[]>,
  vectorResults: Map<ChunkTable, Record<string, unknown>[]>,
): RankedCandidate[] {
  const map = new Map<string, RankedCandidate>();

  for (const table of CHUNK_TABLES) {
    const rows = bm25Results.get(table) ?? [];
    rows.forEach((row, idx) => {
      const id = row.id as string;
      const key = `${table}:${id}`;
      const existing = map.get(key);
      if (existing) {
        existing.rankBm25 = idx + 1;
      } else {
        map.set(key, {
          key,
          table,
          id,
          row,
          rankBm25: idx + 1,
          rankVector: null,
          rrfScore: 0,
        });
      }
    });
  }

  for (const table of CHUNK_TABLES) {
    const rows = vectorResults.get(table) ?? [];
    rows.forEach((row, idx) => {
      const id = row.id as string;
      const key = `${table}:${id}`;
      const existing = map.get(key);
      if (existing) {
        existing.rankVector = idx + 1;
      } else {
        map.set(key, {
          key,
          table,
          id,
          row,
          rankBm25: null,
          rankVector: idx + 1,
          rrfScore: 0,
        });
      }
    });
  }

  for (const c of map.values()) {
    c.rrfScore = (c.rankBm25 !== null ? 1 / (RRF_K + c.rankBm25) : 0) +
      (c.rankVector !== null ? 1 / (RRF_K + c.rankVector) : 0);
  }

  return Array.from(map.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}

function minuteFloor(d: Date): string {
  const out = new Date(d);
  out.setUTCSeconds(0, 0);
  return out.toISOString();
}

const VERSION_HISTORY_INCOMPLETE_CAVEAT = "Version history may be incomplete";

function testCandidate(
  table: ChunkTable,
  id: string,
  row: Record<string, unknown> = {},
): EnrichedCandidate {
  return {
    key: `${table}:${id}`,
    table,
    id,
    row: { id, ...row },
    rankBm25: 1,
    rankVector: null,
    rrfScore: 1 / (60 + 1),
    ancestors: [],
    municode_node_id: table === "ordinance_provisions" ? id : undefined,
    superseded_date: null,
    hasAmendmentHistory: false,
  };
}

function isHistoricalQuery(query: string): boolean {
  return /\b(19|20)\d{2}\b/.test(query) ||
    /\b(as of|at the time of|before the|prior to|in january|in february|in march|in april|in may|in june|in july|in august|in september|in october|in november|in december)\b/i
      .test(query);
}

function hasExplicitCurrentIntent(query: string): boolean {
  return /\b(current|currently|now|today|present|latest|this year|current rate)\b/i
    .test(query) ||
    /\b(what(?:'s| is)|show|give|tell)\b[\s\S]*\btax\b[\s\S]*\brate\b/i
      .test(query);
}

function isHistoricalOnlyQuery(query: string): boolean {
  return isHistoricalQuery(query) && !hasExplicitCurrentIntent(query);
}

function isCurrentStateQuery(query: string): boolean {
  return hasExplicitCurrentIntent(query);
}

function normalizedText(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/(?<=\d),(?=\d)/g, "").replace(
      /[^a-z0-9]+/g,
      " ",
    ).trim()
    : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function candidateText(c: EnrichedCandidate): string {
  if (c.table === "budget_indicators") {
    return [
      c.row.raw_extracted_text,
      c.row.fiscal_year,
      c.row.program,
      c.row.indicator_name,
      c.row.value_actual,
      c.row.unit,
    ].map((value) => value === null || value === undefined ? "" : String(value))
      .join(" ");
  }
  if (c.table === "narrative_chunks") return normalizedText(c.row.content);
  return "";
}

function candidateCorpus(c: EnrichedCandidate, doc?: SourceDocument): string {
  return [
    candidateText(c),
    c.row.program,
    c.row.indicator_name,
    c.row.department,
    doc?.title,
    doc?.filename,
    doc?.url,
  ].map(normalizedText).join(" ");
}

const BUDGET_INDICATOR_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "county",
  "current",
  "currently",
  "different",
  "fairfax",
  "for",
  "in",
  "is",
  "it",
  "latest",
  "now",
  "of",
  "rate",
  "the",
  "this",
  "today",
  "va",
  "value",
  "virginia",
  "was",
  "what",
  "whats",
  "year",
]);

function budgetIndicatorQueryTerms(query: string): string[] {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const terms = normalized.split(/\s+/).filter((term) =>
    term.length > 2 && !BUDGET_INDICATOR_STOPWORDS.has(term) &&
    !/^(19|20)\d{2}$/.test(term)
  );
  return [...new Set(terms)];
}

function matchesBudgetIndicatorQuery(
  query: string,
  c: EnrichedCandidate,
  doc?: SourceDocument,
): boolean {
  const corpus = candidateCorpus(c, doc);
  const terms = budgetIndicatorQueryTerms(query);
  if (terms.length === 0) return true;
  const hasTotSynonym = /\btot\b/.test(corpus) &&
    terms.includes("transient") && terms.includes("occupancy");
  return terms.every((term) =>
    corpus.includes(term) ||
    (hasTotSynonym && (term === "transient" || term === "occupancy"))
  );
}

function isRelevantTaxRateCandidate(
  query: string,
  c: EnrichedCandidate,
  doc?: SourceDocument,
): boolean {
  if (!/\btax\b/i.test(query) || !/\brate\b/i.test(query)) return false;
  const corpus = candidateCorpus(c, doc);
  if (c.table === "budget_indicators") {
    const structuredRateFields = [c.row.indicator_name, c.row.unit]
      .map(normalizedText)
      .join(" ");
    const unit = normalizedText(c.row.unit);
    const actual = asNumber(c.row.value_actual);
    const plainDollarAmount = /\bdollars?\b/.test(unit) &&
      !/\bper\s+\$?100\b/.test(unit);
    const rowItselfIsRate = /\brate\b/.test(structuredRateFields) ||
      /\bper\s+\$?100\b/.test(structuredRateFields) ||
      /\bpercent(age)?\b/.test(unit);
    const rowValueIsPlausibleRate = actual === null || actual <= 100;
    return rowItselfIsRate && rowValueIsPlausibleRate &&
      !plainDollarAmount && /\btax\b/.test(corpus) &&
      /\brate\b/.test(corpus) &&
      matchesBudgetIndicatorQuery(query, c, doc);
  }
  if (c.table === "narrative_chunks") {
    return /\btax\b/.test(corpus) && /\brate\b/.test(corpus) &&
      matchesBudgetIndicatorQuery(query, c, doc);
  }
  return /\btax\b/.test(corpus) && /\brate\b/.test(corpus);
}

function isAdoptedBudgetSource(
  c: EnrichedCandidate,
  doc?: SourceDocument,
): boolean {
  const corpus = candidateCorpus(c, doc);
  if (!hasDraftSourceStatus(doc) && hasFinalAdoptedRateSignal(c)) {
    return true;
  }
  return /\badopt(ed|ion)?\b/.test(corpus) &&
    !hasDraftQualifierNearRateMention(c) &&
    !hasDraftSourceStatus(doc);
}

function parseDocumentFiscalYear(doc?: SourceDocument): number | null {
  if (!doc) return null;
  const explicitFiscalYear = asNumber(doc.fiscal_year);
  if (explicitFiscalYear !== null) return explicitFiscalYear;

  const text = [doc.url, doc.title, doc.filename].filter(Boolean).join(" ");
  const fiscalYear = text.match(
    /\b(?:fy|fiscal[-_\s]*year[-_\s]*)(20\d{2})\b/i,
  );
  if (fiscalYear) return Number(fiscalYear[1]);

  return null;
}

function parseDocumentRecencyScore(doc?: SourceDocument): number | null {
  if (!doc) return null;
  const fiscalYear = parseDocumentFiscalYear(doc);
  if (fiscalYear !== null) return 1_000_000 + fiscalYear;

  if (doc.source_published_at) {
    const parsed = Date.parse(doc.source_published_at);
    if (!Number.isNaN(parsed)) return parsed / 86_400_000;
  }
  const text = [doc.title, doc.filename, doc.url].filter(Boolean).join(" ");
  const iso = text.match(
    /\b(20\d{2})[-_/](0?[1-9]|1[0-2])[-_/](0?[1-9]|[12]\d|3[01])\b/,
  );
  if (iso) {
    const parsed = Date.parse(
      `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`,
    );
    if (!Number.isNaN(parsed)) return parsed / 86_400_000;
  }

  const named = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+([0-3]?\d),?\s+(20\d{2})\b/i,
  );
  if (named) {
    const parsed = Date.parse(`${named[1]} ${named[2]}, ${named[3]}`);
    if (!Number.isNaN(parsed)) return parsed / 86_400_000;
  }

  if (doc.ingested_at) {
    const parsed = Date.parse(doc.ingested_at);
    if (!Number.isNaN(parsed)) return parsed / 86_400_000;
  }
  return null;
}

function hasDraftQualifierNearRateMention(
  c: EnrichedCandidate,
): boolean {
  const content = candidateText(c);
  const rateMention =
    /\btax\s+rate\b[\s\S]{0,100}(?:\d+(?:\.\d+)?\s*(?:%|percent)|\$\s*\d+(?:\.\d+)?)/ig;
  const valueThenRate =
    /(?:\d+(?:\.\d+)?\s*(?:%|percent)|\$\s*\d+(?:\.\d+)?)[\s\S]{0,100}\btax\s+rate\b/ig;
  const draftRegex = /\b(proposed|advertised|mark[- ]?up|markup|draft)\b/i;
  const windows: string[] = [];

  for (const regex of [rateMention, valueThenRate]) {
    for (const match of content.matchAll(regex)) {
      windows.push(match[0]);
    }
  }

  return windows.some((window) => draftRegex.test(window));
}

function hasDraftSourceStatus(doc?: SourceDocument): boolean {
  const sourceStatus = [doc?.title, doc?.filename, doc?.url]
    .map(normalizedText)
    .join(" ");
  return /\b(proposed|advertised|mark[- ]?up|markup|draft)\b/.test(
    sourceStatus,
  );
}

function hasDraftQualifierForRateEvidence(
  c: EnrichedCandidate,
  doc?: SourceDocument,
): boolean {
  if (!hasDraftSourceStatus(doc) && hasFinalAdoptedRateSignal(c)) {
    return false;
  }
  return hasDraftQualifierNearRateMention(c) || hasDraftSourceStatus(doc);
}

function canonicalBudgetDocumentScore(doc?: SourceDocument): number {
  const source = [doc?.title, doc?.filename, doc?.url]
    .map(normalizedText)
    .join(" ");
  let score = 0;

  if (/\badopted(?:%20|\s|-)*budget(?:%20|\s|-)*summary\b/.test(source)) {
    score += 500;
  }
  if (
    /\bgeneral(?:%20|\s|-)*fund(?:%20|\s|-)*revenue(?:%20|\s|-)*overview\b/
      .test(source)
  ) {
    score += 400;
  }
  if (
    /\btrends(?:%20|\s|-)*(?:and|%26)(?:%20|\s|-)*demographics\b/.test(source)
  ) {
    score += 300;
  }
  if (/\bfy20\d{2}(?:%20|\s|-)*adopted(?:%20|\s|-)*package\b/.test(source)) {
    score += 250;
  }
  if (/\bcex(?:%20|\s|-)*letter\b/.test(source)) {
    score -= 400;
  }
  if (/\bvolume2\b/.test(source)) {
    score -= 100;
  }

  return score;
}

function finalAdoptedRateTextScore(c: EnrichedCandidate): number {
  const text = normalizedText(candidateText(c));
  let score = 0;

  if (/\badopt(?:ed|ion)\b[\s\S]{0,120}\btax\s+rate\b/.test(text)) {
    score += 600;
  }
  if (
    /\btax\s+rate\b[\s\S]{0,160}\b(?:decreas|reduc|lower)(?:ed|tion|ing)?\b/
      .test(text) ||
    /\b(?:decreas|reduc|lower)(?:ed|tion|ing)?\b[\s\S]{0,160}\btax\s+rate\b/
      .test(text)
  ) {
    score += 550;
  }
  if (
    /\bfrom\s+\$?\d+(?:\.\d+)?[\s\S]{0,80}\bto\s+\$?\d+(?:\.\d+)?/.test(text)
  ) {
    score += 350;
  }
  if (/\badvertised\s+budget\s+plan\b[\s\S]{0,160}\btax\s+rate\b/.test(text)) {
    score -= 500;
  }

  return score;
}

function budgetIndicatorTiebreakScore(
  c: EnrichedCandidate,
  doc?: SourceDocument,
): number {
  return finalAdoptedRateTextScore(c) + canonicalBudgetDocumentScore(doc);
}

function hasFinalAdoptedRateSignal(c: EnrichedCandidate): boolean {
  return finalAdoptedRateTextScore(c) >= 550;
}

function currentStateScore(
  query: string,
  c: EnrichedCandidate,
  doc?: SourceDocument,
): number {
  return structuredCurrentValueScore(query, c, doc);
}

function compareCurrentStateCandidates(
  query: string,
  documents: Map<string, SourceDocument>,
): (a: EnrichedCandidate, b: EnrichedCandidate) => number {
  return (a, b) => {
    const docA = typeof a.row.document_id === "string"
      ? documents.get(a.row.document_id)
      : undefined;
    const docB = typeof b.row.document_id === "string"
      ? documents.get(b.row.document_id)
      : undefined;
    const scoreDelta = currentStateScore(query, b, docB) -
      currentStateScore(query, a, docA);
    if (scoreDelta !== 0) return scoreDelta;
    return b.rrfScore - a.rrfScore;
  };
}

function rerankCurrentStateCandidatesForTest(
  query: string,
  candidates: EnrichedCandidate[],
  documents: Map<string, SourceDocument>,
): EnrichedCandidate[] {
  if (!isCurrentStateQuery(query)) return candidates;
  return [...candidates].sort(compareCurrentStateCandidates(query, documents));
}

function selectedCurrentBudgetIndicatorsForTest(
  query: string,
  rows: EnrichedCandidate[],
  documents: Map<string, SourceDocument>,
): EnrichedCandidate[] {
  if (
    !isCurrentStateQuery(query) || !/\btax\b/i.test(query) ||
    !/\brate\b/i.test(query)
  ) {
    return [];
  }

  return rows
    .filter((row) => {
      const doc = typeof row.row.document_id === "string"
        ? documents.get(row.row.document_id)
        : undefined;
      return isAdoptedBudgetSource(row, doc) &&
        isRelevantTaxRateCandidate(query, row, doc);
    })
    .sort(compareCurrentStateCandidates(query, documents))
    .slice(0, 3);
}

function fkCandidate(
  table: "vote_tallies" | "policy_decisions",
  row: Record<string, unknown>,
): EnrichedCandidate {
  const id = row.id as string;
  return {
    key: `${table}:${id}`,
    table,
    id,
    row,
    rankBm25: null,
    rankVector: null,
    rrfScore: 0,
    ancestors: [],
    municode_node_id: undefined,
    superseded_date: null,
    hasAmendmentHistory: false,
  };
}

function appendFetchedFkRows(
  candidates: EnrichedCandidate[],
  voteRows: Record<string, unknown>[],
  decisionRows: Record<string, unknown>[],
): EnrichedCandidate[] {
  const seenKeys = new Set(candidates.map((c) => c.key));
  const appended: EnrichedCandidate[] = [];

  for (const row of voteRows) {
    const linked = fkCandidate("vote_tallies", row);
    if (!seenKeys.has(linked.key)) {
      appended.push(linked);
      seenKeys.add(linked.key);
    }
  }

  for (const row of decisionRows) {
    const linked = fkCandidate("policy_decisions", row);
    if (!seenKeys.has(linked.key)) {
      appended.push(linked);
      seenKeys.add(linked.key);
    }
  }

  return [...candidates, ...appended];
}

function appendCaveat(existing: string | null, caveat: string): string {
  if (existing === null || existing.trim() === "") return caveat;
  if (existing.includes(caveat)) return existing;
  return `${existing} ${caveat}`;
}

function countVersionChunks(candidates: EnrichedCandidate[]): number {
  return candidates.filter((c) => c.table === "ordinance_provisions").length;
}

function applyCompletenessCheck(
  candidates: EnrichedCandidate[],
  temporalFlag: boolean,
  amendmentCaveat: string | null,
): { incompleteSearchWarning: boolean; amendmentCaveat: string | null } {
  if (!temporalFlag || countVersionChunks(candidates) >= 2) {
    return { incompleteSearchWarning: false, amendmentCaveat };
  }

  return {
    incompleteSearchWarning: true,
    amendmentCaveat: appendCaveat(
      amendmentCaveat,
      VERSION_HISTORY_INCOMPLETE_CAVEAT,
    ),
  };
}

interface CitationMapEntry {
  chunk_id: string;
  page: number | null;
  bbox: unknown | null;
}

interface CitationChunk {
  chunk_id: string;
  source_url: string;
  source_title: string;
  page_number: number | null;
  bbox: unknown | null;
  retrieved_at: string | null;
  formatted: string;
  rank: number;
}

interface AnswerDraftResult {
  answer: string;
  citations: CitationChunk[];
  citationMap: Record<string, CitationMapEntry>;
  chunkText: Record<string, string>;
}

interface LlmCallBudget {
  used: number;
  cap: number;
}

const UNVERIFIED_CAVEAT =
  "Caveat: This answer could not be fully verified against the cited source text.";

function testDraft(claims: string[]): AnswerDraftResult {
  const citationMap: Record<string, CitationMapEntry> = {};
  for (const claim of claims) {
    citationMap[claim] = {
      chunk_id: "00000000-0000-0000-0000-000000000099",
      page: null,
      bbox: null,
    };
  }
  return {
    answer: claims.join(" ") ||
      "not in the documents [chunk_id=00000000-0000-0000-0000-000000000099; page=null; bbox=null]",
    citations: [],
    citationMap,
    chunkText: { "00000000-0000-0000-0000-000000000099": "source text" },
  };
}

function textHasNumber(text: string): boolean {
  return /\b\d+(?:[,\d]*\d)?(?:\.\d+)?%?\b/.test(text);
}

function draftHasNumericClaim(draft: AnswerDraftResult): boolean {
  const claims = Object.keys(draft.citationMap);
  if (claims.length > 0) return claims.some(textHasNumber);

  const withoutUuidCitations = draft.answer.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "",
  );
  return textHasNumber(withoutUuidCitations);
}

function shouldRunVerifier(
  draft: AnswerDraftResult,
  temporalFlag: boolean,
): boolean {
  return temporalFlag || draftHasNumericClaim(draft);
}

function hasRemainingLlmCall(budget: LlmCallBudget): boolean {
  return budget.used < budget.cap;
}

function consumeLlmCall(budget: LlmCallBudget): boolean {
  if (!hasRemainingLlmCall(budget)) return false;
  budget.used += 1;
  return true;
}

function withUnverifiedCaveat(draft: AnswerDraftResult): AnswerDraftResult {
  if (draft.answer.includes(UNVERIFIED_CAVEAT)) return draft;
  return {
    ...draft,
    answer: `${draft.answer.trim()}\n\n${UNVERIFIED_CAVEAT}`,
  };
}

function retrievedDate(ingestedAt: string | null): string {
  if (!ingestedAt) return "retrieval date unavailable";
  const parsed = new Date(ingestedAt);
  if (Number.isNaN(parsed.getTime())) return "retrieval date unavailable";
  return parsed.toISOString().slice(0, 10);
}

function formatCitation(
  title: string,
  page: number | null,
  ingestedAt: string | null,
): string {
  const pageText = page === null ? "page n/a" : `page ${page}`;
  return `[${title}, ${pageText}, retrieved ${retrievedDate(ingestedAt)}]`;
}

// ── Source title resolution (mirrors index.ts's sourceTitle) ─────────────────

interface SourceDocument {
  id: string;
  url: string;
  title: string | null;
  filename: string | null;
  ingested_at: string;
  doc_type: string | null;
  source_published_at: string | null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  bos_summary: "Board Summary",
  bos_minutes: "Board Minutes",
  budget_pdf: "Budget Document",
  municode_api: "Municode Ordinance",
  encode_zoning: "Zoning Ordinance",
};

const CHUNK_TABLE_LABELS: Record<ChunkTable, string> = {
  ordinance_provisions: "Ordinance Provision",
  vote_tallies: "Vote Tally",
  policy_decisions: "Policy Decision",
  budget_indicators: "Budget Indicator",
  narrative_chunks: "Document",
};

function fallbackSourceDate(doc: SourceDocument | undefined): string | null {
  if (!doc) return null;
  const raw = doc.source_published_at ?? doc.ingested_at;
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function sourceTitle(
  doc: SourceDocument | undefined,
  c: EnrichedCandidate,
): string {
  if (doc?.title) return doc.title;
  if (doc?.filename) return doc.filename;
  if (c.table === "ordinance_provisions") {
    const provisionTitle = asText(c.row.section_title) ??
      asText(c.row.municode_node_id);
    if (provisionTitle) return provisionTitle;
  }

  const label = (doc?.doc_type && DOC_TYPE_LABELS[doc.doc_type]) ??
    CHUNK_TABLE_LABELS[c.table];
  const date = fallbackSourceDate(doc);
  return date ? `${label} — ${date}` : label;
}

function validIsoTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function mostRecentRetrievedAt(citations: CitationChunk[]): string | null {
  let latestMs = -Infinity;
  let latestIso: string | null = null;

  for (const citation of citations) {
    const iso = validIsoTimestamp(citation.retrieved_at);
    if (!iso) continue;
    const ms = new Date(iso).getTime();
    if (ms > latestMs) {
      latestMs = ms;
      latestIso = iso;
    }
  }

  return latestIso;
}

function freshnessNotice(freshnessTimestamp: string | null): string | null {
  if (!freshnessTimestamp) return null;
  return `Sources current as of ${retrievedDate(freshnessTimestamp)}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

Deno.test("minuteFloor zeroes seconds and milliseconds", () => {
  const d = new Date("2026-06-22T04:31:47.123Z");
  const result = minuteFloor(d);
  if (result !== "2026-06-22T04:31:00.000Z") {
    throw new Error(`expected 2026-06-22T04:31:00.000Z, got ${result}`);
  }
});

Deno.test("RRF dedup key is table-qualified, not bare id", () => {
  const uuid = "00000000-0000-0000-0000-000000000001";
  const bm25 = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: uuid, content: "test" }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);
  const vector = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: uuid, content: "test" }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);

  const result = rrfMerge(bm25, vector);
  if (result.length !== 1) {
    throw new Error(`expected 1 candidate after dedup, got ${result.length}`);
  }
  if (result[0].key !== `ordinance_provisions:${uuid}`) {
    throw new Error(`expected table-qualified key, got ${result[0].key}`);
  }
});

Deno.test("RRF formula: both legs present — 1/(60+rank_bm25) + 1/(60+rank_vector)", () => {
  const uuid = "00000000-0000-0000-0000-000000000001";
  const bm25 = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: uuid }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);
  const vector = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: uuid }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);

  const result = rrfMerge(bm25, vector);
  const expected = 1 / (60 + 1) + 1 / (60 + 1); // rank=1 for both
  const got = result[0].rrfScore;
  if (Math.abs(got - expected) > 1e-12) {
    throw new Error(`RRF score mismatch: expected ${expected}, got ${got}`);
  }
});

Deno.test("RRF formula: only BM25 leg — missing vector contributes 0", () => {
  const uuid = "00000000-0000-0000-0000-000000000001";
  const bm25 = new Map<ChunkTable, Record<string, unknown>[]>([
    ["vote_tallies", [{ id: uuid }]],
    ["ordinance_provisions", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);
  const vector = new Map<ChunkTable, Record<string, unknown>[]>([
    ["vote_tallies", []],
    ["ordinance_provisions", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);

  const result = rrfMerge(bm25, vector);
  const expected = 1 / (60 + 1); // only BM25 leg
  const got = result[0].rrfScore;
  if (Math.abs(got - expected) > 1e-12) {
    throw new Error(`RRF score mismatch: expected ${expected}, got ${got}`);
  }
  if (result[0].rankVector !== null) {
    throw new Error("rankVector should be null when absent from vector leg");
  }
});

Deno.test("RRF sorts by score descending", () => {
  const id1 = "00000000-0000-0000-0000-000000000001";
  const id2 = "00000000-0000-0000-0000-000000000002";
  // id1: rank1 in BM25, rank1 in vector → highest score
  // id2: rank2 in BM25, rank2 in vector → lower score
  const bm25 = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: id1 }, { id: id2 }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);
  const vector = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: id1 }, { id: id2 }]],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);

  const result = rrfMerge(bm25, vector);
  if (result[0].id !== id1) {
    throw new Error(
      `expected id1 first (rank 1 in both legs), got ${result[0].id}`,
    );
  }
  if (result[0].rrfScore <= result[1].rrfScore) {
    throw new Error("result not sorted descending by rrfScore");
  }
});

Deno.test("RRF cross-table dedup: same UUID in different tables are distinct keys", () => {
  const sameUuid = "00000000-0000-0000-0000-000000000001";
  const bm25 = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", [{ id: sameUuid }]],
    ["vote_tallies", [{ id: sameUuid }]], // same UUID, different table
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);
  const vector = new Map<ChunkTable, Record<string, unknown>[]>([
    ["ordinance_provisions", []],
    ["vote_tallies", []],
    ["policy_decisions", []],
    ["budget_indicators", []],
    ["narrative_chunks", []],
  ]);

  const result = rrfMerge(bm25, vector);
  // Same UUID across two tables = two distinct candidates (table-qualified keys differ)
  if (result.length !== 2) {
    throw new Error(
      `expected 2 candidates (cross-table same UUID), got ${result.length}`,
    );
  }
  const keys = result.map((c) => c.key).sort();
  if (!keys.includes(`ordinance_provisions:${sameUuid}`)) {
    throw new Error("missing ordinance_provisions key");
  }
  if (!keys.includes(`vote_tallies:${sameUuid}`)) {
    throw new Error("missing vote_tallies key");
  }
});

Deno.test("RRF empty results → empty candidates array", () => {
  const empty = new Map<ChunkTable, Record<string, unknown>[]>(
    CHUNK_TABLES.map((t) => [t, []]),
  );
  const result = rrfMerge(empty, empty);
  if (result.length !== 0) {
    throw new Error(`expected 0 candidates, got ${result.length}`);
  }
});

Deno.test("FK traversal appends linked reconsideration vote rows after context", () => {
  const originalId = "00000000-0000-0000-0000-000000000010";
  const reconsideredBy = "00000000-0000-0000-0000-000000000011";
  const context = [
    testCandidate("vote_tallies", originalId, {
      reconsidered_by: reconsideredBy,
    }),
  ];

  const result = appendFetchedFkRows(
    context,
    [{ id: reconsideredBy, motion_text: "reconsidered motion" }],
    [],
  );

  if (result.length !== 2) {
    throw new Error(
      `expected linked vote row to be appended, got ${result.length} rows`,
    );
  }
  if (result[1].key !== `vote_tallies:${reconsideredBy}`) {
    throw new Error(`expected reconsideration vote key, got ${result[1].key}`);
  }
  if (result[1].rrfScore !== 0) {
    throw new Error("linked FK row should not inherit an RRF score");
  }
});

Deno.test("FK traversal appends linked original policy decision rows after context", () => {
  const amendmentId = "00000000-0000-0000-0000-000000000020";
  const originalId = "00000000-0000-0000-0000-000000000021";
  const context = [
    testCandidate("policy_decisions", amendmentId, {
      amends_decision_id: originalId,
    }),
  ];

  const result = appendFetchedFkRows(
    context,
    [],
    [{ id: originalId, subject: "original budget adoption" }],
  );

  if (result.length !== 2) {
    throw new Error(
      `expected linked decision row to be appended, got ${result.length} rows`,
    );
  }
  if (result[1].key !== `policy_decisions:${originalId}`) {
    throw new Error(`expected original decision key, got ${result[1].key}`);
  }
});

Deno.test("FK traversal does not duplicate rows already present in context", () => {
  const originalId = "00000000-0000-0000-0000-000000000030";
  const linkedId = "00000000-0000-0000-0000-000000000031";
  const context = [
    testCandidate("vote_tallies", originalId, { reconsidered_by: linkedId }),
    testCandidate("vote_tallies", linkedId),
  ];

  const result = appendFetchedFkRows(context, [{ id: linkedId }], []);

  if (result.length !== 2) {
    throw new Error(
      `expected no duplicate linked row, got ${result.length} rows`,
    );
  }
});

Deno.test("completeness check flags temporal context with fewer than two version chunks", () => {
  const context = [
    testCandidate(
      "ordinance_provisions",
      "00000000-0000-0000-0000-000000000040",
    ),
    testCandidate("vote_tallies", "00000000-0000-0000-0000-000000000041"),
  ];

  const result = applyCompletenessCheck(context, true, "Existing caveat.");

  if (!result.incompleteSearchWarning) {
    throw new Error("expected incompleteSearchWarning=true");
  }
  if (
    result.amendmentCaveat !==
      "Existing caveat. Version history may be incomplete"
  ) {
    throw new Error(`unexpected caveat: ${result.amendmentCaveat}`);
  }
});

Deno.test("completeness check passes temporal context with at least two version chunks", () => {
  const context = [
    testCandidate(
      "ordinance_provisions",
      "00000000-0000-0000-0000-000000000050",
    ),
    testCandidate(
      "ordinance_provisions",
      "00000000-0000-0000-0000-000000000051",
    ),
  ];

  const result = applyCompletenessCheck(context, true, null);

  if (result.incompleteSearchWarning) {
    throw new Error("expected incompleteSearchWarning=false");
  }
  if (result.amendmentCaveat !== null) {
    throw new Error(`expected null caveat, got ${result.amendmentCaveat}`);
  }
});

Deno.test("verifier trigger: numeric cited claim runs verifier", () => {
  const draft = testDraft(["The fee is 25 dollars"]);

  if (!shouldRunVerifier(draft, false)) {
    throw new Error("expected numeric claim to trigger verifier");
  }
});

Deno.test("verifier trigger: temporal flag runs verifier without numeric claim", () => {
  const draft = testDraft(["The ordinance is current"]);

  if (!shouldRunVerifier(draft, true)) {
    throw new Error("expected temporal_flag=true to trigger verifier");
  }
});

Deno.test("verifier trigger: nonnumeric non-temporal draft skips verifier", () => {
  const draft = testDraft(["The ordinance applies to residential permits"]);

  if (shouldRunVerifier(draft, false)) {
    throw new Error("expected nonnumeric non-temporal draft to skip verifier");
  }
});

Deno.test("verifier trigger ignores UUID-only citation numbers when no claim map exists", () => {
  const draft = testDraft([]);

  if (shouldRunVerifier(draft, false)) {
    throw new Error(
      "expected UUID citation numbers alone not to trigger verifier",
    );
  }
});

Deno.test("verifier correction budget caps post-draft calls and falls back with caveat", () => {
  const budget = { used: 2, cap: 5 };

  if (!consumeLlmCall(budget)) throw new Error("expected verifier call budget");
  if (!consumeLlmCall(budget)) {
    throw new Error("expected first correction call budget");
  }
  if (!consumeLlmCall(budget)) {
    throw new Error("expected second correction call budget");
  }
  if (consumeLlmCall(budget)) {
    throw new Error("must not allow a sixth total LLM call");
  }
  if (budget.used !== 5) throw new Error(`expected used=5, got ${budget.used}`);

  const caveated = withUnverifiedCaveat(testDraft(["The fee is 25 dollars"]));
  if (!caveated.answer.includes(UNVERIFIED_CAVEAT)) {
    throw new Error(
      "expected unverified caveat after exhausted correction passes",
    );
  }
});

Deno.test("sourceTitle prefers the document's real title when populated", () => {
  const doc: SourceDocument = {
    id: "d1",
    url: "https://example.test/doc.pdf",
    title: "FY 2026 Adopted Budget",
    filename: null,
    ingested_at: "2026-06-20T15:30:00Z",
    doc_type: "budget_pdf",
    source_published_at: null,
    fiscal_year: null,
  };
  const title = sourceTitle(
    doc,
    testCandidate("budget_indicators", "00000000-0000-0000-0000-000000000d01"),
  );
  if (title !== "FY 2026 Adopted Budget") {
    throw new Error(`expected real title, got: ${title}`);
  }
});

Deno.test("sourceTitle falls back to filename when title is missing", () => {
  const doc: SourceDocument = {
    id: "d1",
    url: "https://example.test/doc.pdf",
    title: null,
    filename: "budget-2026.pdf",
    ingested_at: "2026-06-20T15:30:00Z",
    doc_type: "budget_pdf",
    source_published_at: null,
    fiscal_year: null,
  };
  const title = sourceTitle(
    doc,
    testCandidate("budget_indicators", "00000000-0000-0000-0000-000000000d01"),
  );
  if (title !== "budget-2026.pdf") {
    throw new Error(`expected filename fallback, got: ${title}`);
  }
});

Deno.test("sourceTitle never surfaces the raw table name when title/filename are both null", () => {
  // Regression test: bos_summary/bos_minutes/budget_pdf documents currently
  // have title=null and filename=null for every ingested row (a real
  // ingestion gap — see PR description) — this previously leaked the raw
  // Postgres table name (e.g. 'narrative_chunks') into user-facing citations.
  const doc: SourceDocument = {
    id: "d1",
    url: "https://example.test/BOS_2026-06-09.pdf",
    title: null,
    filename: null,
    ingested_at: "2026-06-09T12:00:00Z",
    doc_type: "bos_summary",
    source_published_at: null,
    fiscal_year: null,
  };
  const title = sourceTitle(
    doc,
    testCandidate("narrative_chunks", "00000000-0000-0000-0000-000000000d02"),
  );
  if (title === "narrative_chunks") {
    throw new Error("raw table name leaked into citation title");
  }
  if (title !== "Board Summary — 2026-06-09") {
    throw new Error(`unexpected fallback title: ${title}`);
  }
});

Deno.test("sourceTitle maps every known doc_type to a human-readable label", () => {
  const cases: Array<[string, string]> = [
    ["bos_summary", "Board Summary"],
    ["bos_minutes", "Board Minutes"],
    ["budget_pdf", "Budget Document"],
    ["municode_api", "Municode Ordinance"],
    ["encode_zoning", "Zoning Ordinance"],
  ];
  for (const [docType, label] of cases) {
    const doc: SourceDocument = {
      id: "d1",
      url: "https://example.test/doc",
      title: null,
      filename: null,
      ingested_at: "2026-06-09T12:00:00Z",
      doc_type: docType,
      source_published_at: null,
      fiscal_year: null,
    };
    const title = sourceTitle(
      doc,
      testCandidate("narrative_chunks", "00000000-0000-0000-0000-000000000d02"),
    );
    if (title !== `${label} — 2026-06-09`) {
      throw new Error(
        `doc_type ${docType}: expected "${label} — 2026-06-09", got "${title}"`,
      );
    }
  }
});

Deno.test("sourceTitle prefers source_published_at over ingested_at when both are present", () => {
  const doc: SourceDocument = {
    id: "d1",
    url: "https://example.test/doc.pdf",
    title: null,
    filename: null,
    ingested_at: "2026-07-15T00:54:03Z",
    doc_type: "bos_summary",
    source_published_at: "1995-08-07",
    fiscal_year: null,
  };
  const title = sourceTitle(
    doc,
    testCandidate("narrative_chunks", "00000000-0000-0000-0000-000000000d02"),
  );
  if (title !== "Board Summary — 1995-08-07") {
    throw new Error(`expected real document date to win, got: ${title}`);
  }
});

Deno.test("sourceTitle uses section_title for ordinance_provisions before falling back", () => {
  const title = sourceTitle(
    undefined,
    testCandidate(
      "ordinance_provisions",
      "00000000-0000-0000-0000-000000000d03",
      { section_title: "Sect. 8-918" },
    ),
  );
  if (title !== "Sect. 8-918") {
    throw new Error(`expected section_title, got: ${title}`);
  }
});

Deno.test("sourceTitle never surfaces the raw table name when no document row exists at all", () => {
  // Covers a dangling document_id / lookup failure: fetchSourceDocuments()
  // returns an empty map for that id, so doc is undefined here.
  const title = sourceTitle(
    undefined,
    testCandidate("budget_indicators", "00000000-0000-0000-0000-000000000d01"),
  );
  if (title === "budget_indicators") {
    throw new Error("raw table name leaked into citation title");
  }
  if (title !== "Budget Indicator") {
    throw new Error(`unexpected no-document fallback: ${title}`);
  }
});

Deno.test("response assembly formats citation labels with title page and retrieved date", () => {
  const formatted = formatCitation(
    "FY 2026 Adopted Budget",
    42,
    "2026-06-20T15:30:00Z",
  );

  if (formatted !== "[FY 2026 Adopted Budget, page 42, retrieved 2026-06-20]") {
    throw new Error(`unexpected formatted citation: ${formatted}`);
  }
});

Deno.test("response assembly replaces inline chunk-id citations with formatted citations", () => {
  const chunkId = "00000000-0000-0000-0000-000000000099";
  const citations: CitationChunk[] = [{
    chunk_id: chunkId,
    source_url: "https://example.test/budget.pdf",
    source_title: "FY 2026 Adopted Budget",
    page_number: 42,
    bbox: null,
    retrieved_at: "2026-06-20T15:30:00Z",
    formatted: "[FY 2026 Adopted Budget, page 42, retrieved 2026-06-20]",
    rank: 1,
  }];

  const answer =
    `The tax rate is 1.12. [chunk_id=${chunkId}; page=42; bbox=null]`;
  const formatted = formatInlineAnswerCitations(answer, citations);

  if (formatted.includes("chunk_id=")) {
    throw new Error(
      `expected internal chunk citation to be removed: ${formatted}`,
    );
  }
  if (
    !formatted.includes(
      "[FY 2026 Adopted Budget, page 42, retrieved 2026-06-20]",
    )
  ) {
    throw new Error(`expected formatted citation in answer: ${formatted}`);
  }
});

Deno.test("response assembly removes raw chunk-id citation with nested bbox JSON", () => {
  const chunkId = "019f7e43-dd00-742a-bf02-038b64604d16";
  const citations: CitationChunk[] = [{
    chunk_id: chunkId,
    source_url: "https://example.test/minutes.pdf",
    source_title: "Board Minutes — 2024-09-17",
    page_number: 4,
    bbox: {
      start: [{ x: 72.1, y: 121.4 }, { x: 412.7, y: 121.4 }],
      end: [{ x: 72.1, y: 140.8 }, { x: 501.2, y: 140.8 }],
    },
    retrieved_at: "2026-07-20T00:00:00Z",
    formatted: "[Board Minutes — 2024-09-17, page 4, retrieved 2026-07-20]",
    rank: 1,
  }];

  const answer =
    `Fairfax County currently levies a 4% transient occupancy tax, consisting of 2% for general purposes and 2% to promote tourism [chunk_id=${chunkId}; page=4; bbox={"start":[{"x":72.1,"y":121.4},{"x":412.7,"y":121.4}],"end":[{"x":72.1,"y":140.8},{"x":501.2,"y":140.8}]}].`;
  const formatted = formatInlineAnswerCitations(answer, citations);

  if (formatted.includes("chunk_id=") || formatted.includes("bbox=")) {
    throw new Error(
      `expected raw citation metadata to be removed: ${formatted}`,
    );
  }
  if (
    !formatted.includes(
      "[Board Minutes — 2024-09-17, page 4, retrieved 2026-07-20]",
    )
  ) {
    throw new Error(`expected formatted citation in answer: ${formatted}`);
  }
});

Deno.test("response assembly replaces comma-joined multi chunk-id citations", () => {
  const firstChunkId = "019f4c4c-0000-7000-8000-000000000001";
  const secondChunkId = "019f8b52-0000-7000-8000-000000000002";
  const citations: CitationChunk[] = [{
    chunk_id: firstChunkId,
    source_url: "https://example.test/ordinance",
    source_title: "Fairfax County Code",
    page_number: null,
    bbox: null,
    retrieved_at: "2026-07-20T00:00:00Z",
    formatted: "[Fairfax County Code, page n/a, retrieved 2026-07-20]",
    rank: 1,
  }, {
    chunk_id: secondChunkId,
    source_url: "https://example.test/zoning",
    source_title: "Zoning Ordinance",
    page_number: null,
    bbox: null,
    retrieved_at: "2026-07-21T00:00:00Z",
    formatted: "[Zoning Ordinance, page n/a, retrieved 2026-07-21]",
    rank: 2,
  }];

  const answer =
    `not in the documents [chunk_id=${firstChunkId}, chunk_id=${secondChunkId}]`;
  const formatted = formatInlineAnswerCitations(answer, citations);

  if (formatted.includes("chunk_id=") || formatted.includes(firstChunkId)) {
    throw new Error(`expected audit leak fixture to be removed: ${formatted}`);
  }
  if (
    !formatted.includes(
      "[Fairfax County Code, page n/a, retrieved 2026-07-20]",
    ) ||
    !formatted.includes("[Zoning Ordinance, page n/a, retrieved 2026-07-21]")
  ) {
    throw new Error(`expected both citation labels in answer: ${formatted}`);
  }
  if (!formatted.startsWith("not in the documents ")) {
    throw new Error(`expected surrounding answer text preserved: ${formatted}`);
  }
});

Deno.test("response assembly replaces comma-joined chunk ids with metadata and nested bbox", () => {
  const firstChunkId = "019f4c4c-1111-7111-8111-111111111111";
  const secondChunkId = "019f8b52-2222-7222-8222-222222222222";
  const citations: CitationChunk[] = [{
    chunk_id: firstChunkId,
    source_url: "",
    source_title: "Board Summary",
    page_number: 5,
    bbox: null,
    retrieved_at: "2026-07-20T00:00:00Z",
    formatted: "[Board Summary, page 5, retrieved 2026-07-20]",
    rank: 1,
  }, {
    chunk_id: secondChunkId,
    source_url: "",
    source_title: "Budget Document",
    page_number: 8,
    bbox: null,
    retrieved_at: "2026-07-22T00:00:00Z",
    formatted: "[Budget Document, page 8, retrieved 2026-07-22]",
    rank: 2,
  }];

  const answer =
    `The supported answer remains visible [chunk_id=${firstChunkId}; page=5; bbox={"boxes":[[1,2],[3,4]]}, chunk_id=${secondChunkId}; page=8; bbox={"end":[{"x":72.1,"y":140.8}]}].`;
  const formatted = formatInlineAnswerCitations(answer, citations);

  if (formatted.includes("chunk_id=") || formatted.includes("bbox=")) {
    throw new Error(`expected raw metadata to be removed: ${formatted}`);
  }
  if (!formatted.startsWith("The supported answer remains visible ")) {
    throw new Error(`expected answer text preserved: ${formatted}`);
  }
  if (
    !formatted.includes("[Board Summary, page 5, retrieved 2026-07-20]") ||
    !formatted.includes("[Budget Document, page 8, retrieved 2026-07-22]")
  ) {
    throw new Error(`expected both metadata citations replaced: ${formatted}`);
  }
});

Deno.test("response assembly strips unresolved or malformed chunk-id citations cleanly", () => {
  const unresolved = "019f4c4c-3333-7333-8333-333333333333";
  const malformed = "019f8b52-4444-7444-8444-444444444444";
  const resolved = formatInlineAnswerCitations(
    `Keep this answer [chunk_id=${unresolved}, chunk_id=${malformed}] and this too [chunk_id=${malformed}; page=1.`,
    [],
  );

  if (resolved.includes("chunk_id=") || resolved.includes(unresolved)) {
    throw new Error(`expected raw unresolved ids to be removed: ${resolved}`);
  }
  if (
    !resolved.includes("Keep this answer ") ||
    !resolved.includes(" and this too ")
  ) {
    throw new Error(`expected surrounding answer text preserved: ${resolved}`);
  }
});

Deno.test("response assembly freshness uses most recent cited ingested_at", () => {
  const citations: CitationChunk[] = [
    {
      chunk_id: "00000000-0000-0000-0000-000000000091",
      source_url: "",
      source_title: "Older Source",
      page_number: null,
      bbox: null,
      retrieved_at: "2026-06-18T10:00:00Z",
      formatted: "[Older Source, page n/a, retrieved 2026-06-18]",
      rank: 1,
    },
    {
      chunk_id: "00000000-0000-0000-0000-000000000092",
      source_url: "",
      source_title: "Newer Source",
      page_number: null,
      bbox: null,
      retrieved_at: "2026-06-21T09:00:00Z",
      formatted: "[Newer Source, page n/a, retrieved 2026-06-21]",
      rank: 2,
    },
  ];

  const freshnessTimestamp = mostRecentRetrievedAt(citations);
  if (freshnessTimestamp !== "2026-06-21T09:00:00.000Z") {
    throw new Error(`unexpected freshness timestamp: ${freshnessTimestamp}`);
  }
  if (
    freshnessNotice(freshnessTimestamp) !== "Sources current as of 2026-06-21"
  ) {
    throw new Error("unexpected freshness notice");
  }
});

Deno.test("current-state rerank prefers latest adopted real estate tax budget indicator", () => {
  const markupDocId = "00000000-0000-0000-0000-000000000201";
  const adoptedDocId = "00000000-0000-0000-0000-000000000202";
  const oldMarkup = testCandidate("budget_indicators", "old-markup", {
    document_id: markupDocId,
    fiscal_year: 2025,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.125,
    unit: "dollars per $100 assessed value",
    raw_extracted_text:
      "FY 2025 Budget Mark-Up proposes a Real Estate tax rate of $1.125 per $100.",
  });
  oldMarkup.rrfScore = 0.03;

  const currentAdopted = testCandidate("budget_indicators", "fy2027-adopted", {
    document_id: adoptedDocId,
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.12,
    unit: "dollars per $100 assessed value",
    raw_extracted_text:
      "FY 2027 Adopted Budget sets the Real Estate tax rate at $1.12 per $100.",
  });
  currentAdopted.rrfScore = 0.01;

  const documents = new Map<string, SourceDocument>([
    [markupDocId, {
      id: markupDocId,
      url: "https://example.test/fy2025/markup.pdf",
      title: "FY 2025 Budget Mark-Up",
      filename: "FY2025_Markup.pdf",
      ingested_at: "2026-07-01T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: "2024-04-20",
      fiscal_year: 2025,
    }],
    [adoptedDocId, {
      id: adoptedDocId,
      url: "https://example.test/fy2027/adopted/overview.pdf",
      title: "FY 2027 Adopted Budget Overview",
      filename: "FY2027_Adopted_Overview.pdf",
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: "2026-05-05",
      fiscal_year: 2027,
    }],
  ]);

  const ranked = rerankCurrentStateCandidatesForTest(
    "what is the current tax rate",
    [oldMarkup, currentAdopted],
    documents,
  );

  if (ranked[0].id !== "fy2027-adopted") {
    throw new Error(`expected FY2027 adopted first, got ${ranked[0].id}`);
  }
});

Deno.test("compound current and historical real estate tax query still prefers current $1.12 anchor", () => {
  const currentDocId = "00000000-0000-0000-0000-000000000232";
  const historicalDocId = "00000000-0000-0000-0000-000000000231";
  const historicalRate = testCandidate(
    "budget_indicators",
    "real-estate-fy2020",
    {
      document_id: historicalDocId,
      fiscal_year: 2020,
      program: "Real Estate Tax",
      indicator_name: "Real Estate Tax rate",
      value_actual: 1.15,
      unit: "dollars per $100 assessed value",
      raw_extracted_text:
        "FY 2020 Adopted Budget sets the Real Estate tax rate at $1.15 per $100.",
    },
  );
  historicalRate.rrfScore = 0.03;

  const currentRate = testCandidate("budget_indicators", "real-estate-fy2027", {
    document_id: currentDocId,
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.12,
    unit: "dollars per $100 assessed value",
    raw_extracted_text:
      "FY 2027 Adopted Budget sets the Real Estate tax rate at $1.12 per $100.",
  });
  currentRate.rrfScore = 0.01;

  const documents = new Map<string, SourceDocument>([
    [historicalDocId, {
      id: historicalDocId,
      url: "https://example.test/fy2020/adopted/overview.pdf",
      title: "FY 2020 Adopted Budget Overview",
      filename: "FY2020_Adopted_Overview.pdf",
      ingested_at: "2026-07-01T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: "2019-05-07",
      fiscal_year: 2020,
    }],
    [currentDocId, {
      id: currentDocId,
      url: "https://example.test/fy2027/adopted/overview.pdf",
      title: "FY 2027 Adopted Budget Overview",
      filename: "FY2027_Adopted_Overview.pdf",
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: "2026-05-05",
      fiscal_year: 2027,
    }],
  ]);

  const query =
    "what is the current real estate tax rate, and was it different in 2020?";
  const ranked = rerankCurrentStateCandidatesForTest(
    query,
    [historicalRate, currentRate],
    documents,
  );

  if (isHistoricalOnlyQuery(query)) {
    throw new Error(
      "compound current+historical query was treated as historical-only",
    );
  }
  if (ranked[0].id !== "real-estate-fy2027") {
    throw new Error(`expected current $1.12 row first, got ${ranked[0].id}`);
  }
  if (ranked[0].row.value_actual !== 1.12) {
    throw new Error(
      `expected current value 1.12, got ${ranked[0].row.value_actual}`,
    );
  }
});

Deno.test("current-state rerank uses real FY2027 adopted row over advertised narrative row", () => {
  const adoptedDocId = "019f5735-154a-7182-aa08-e8557b11a214";
  const advertisedDocId = "019f480b-bab2-7242-896c-0083f74c8bd9";
  const query = "what is the current real estate tax rate";
  const currentAdopted = testCandidate(
    "budget_indicators",
    "019f5736-0f82-7310-a4db-c7bbc4806450",
    {
      document_id: adoptedDocId,
      fiscal_year: 2027,
      program: "Real Estate Tax",
      indicator_name: "Real Estate Tax rate",
      value_actual: 1.12,
      unit: "dollars per $100 of assessed value",
      raw_extracted_text:
        "DATE: May 4, 2026 TO: Board of Supervisors FROM: Bryan J. Hill County Executive SUBJECT: Adoption of the FY 2027 Budget Plan Attached for your review are the following documents: Board revenue and expenditure adjustments approved at the Budget Mark-up on April 28, 2026 (Attachment I); Resolution Adopting Tax Rates for FY 2027 (Attachment II); FY 2027 Appropriation Resolution for County Agencies/Funds (Attachment III); FY 2027 Appropriation Resolution for School Board Funds (Attachment IV); FY 2027 Fiscal Planning Resolution (Attachment V); and FY 2027 General Fund Statement; FY 2027 General Fund Expenditures by Agency; FY 2027 Expenditures by Fund, Appropriated; and FY 2027 Expenditures by Fund, NonAppropriated (Attachment VI). The attachments noted above provide the official documentation of the adjustments made by the Board of Supervisors on April 28, 2026, associated with the markup of the FY 2027 budget. It should be noted that the Board took final action on the FY 2027-2031 Capital Improvement Program during budget mark-up on April 28. The Real Estate Tax rate to be approved by the Board will decrease from $1.1225 per $100 of assessed value to $1.12 per $100 of assessed value. The Personal Property Tax rate will remain at $4.57 per $100 of assessed value for most classes of personal property.",
    },
  );
  currentAdopted.rrfScore = 0.01;

  const advertisedNarrative = testCandidate(
    "narrative_chunks",
    "019f480d-1e26-7225-aba3-5c279c2ecbaf",
    {
      document_id: advertisedDocId,
      content:
        "Category Actual Projections FY 2025 FY 2026 FY 2027 FY 2028 Real Estate Tax - Assessment Base 2.73% 5.34% 3.77% 1.10% Equalization 1.91% 4.68% 3.32% 0.80% Residential 2.86% 6.17% 3.99% 1.00% Nonresidential (1.24%) (0.38%) 0.92% 0.00% Normal Growth 0.82% 0.66% 0.45% 0.30% Real Estate Tax Rate per $100 of assessed value 1 $1.125 $1.1225 $1.1225 $1.1225 Personal Property Tax - Current 2 7.22% 2.37% 3.14% 2.00% Local Sales Tax 2.60% 2.00% 1.50% 2.50% Business, Professional and Occupational License (BPOL) Taxes 3.49% 2.02% 1.50% 2.50% Food and Beverage Tax -- -- 100.00% 2.50% Interest on Investments 9.51% (12.79%) (9.58%) 3.08% Interest Rate Earned on Investments 4.47% 4.06% 3.50% 3.50% Fines and Forfeitures 12.76% 0.61% 1.96% 2.50% Charges for Services 6.93% 2.67% 4.72% 2.50% State/Federal Revenue 2 3.80% (2.40%) (1.30%) 2.00% Total General Fund Revenue 5.53% 4.54% 3.75% 1.50% 1 The FY 2028 forecast is based on the current Real Estate tax rate of $1.1225 per $100 of assessed value.",
    },
  );
  advertisedNarrative.rrfScore = 0.03;

  const documents = new Map<string, SourceDocument>([
    [adoptedDocId, {
      id: adoptedDocId,
      url:
        "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/fy2027-adopted-package.pdf",
      title: null,
      filename: null,
      ingested_at: "2026-07-12T16:42:04.490Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
    [advertisedDocId, {
      id: advertisedDocId,
      url:
        "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/advertised/overview/Multi%20Year.pdf",
      title: null,
      filename: null,
      ingested_at: "2026-07-09T18:02:36.082Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
  ]);

  const adoptedScore = currentStateScore(
    query,
    currentAdopted,
    documents.get(adoptedDocId),
  );
  const advertisedScore = currentStateScore(
    query,
    advertisedNarrative,
    documents.get(advertisedDocId),
  );
  if (hasDraftQualifierNearRateMention(currentAdopted)) {
    throw new Error(
      "incidental Budget Mark-up text near the document opening was penalized",
    );
  }
  if (
    hasDraftQualifierForRateEvidence(
      currentAdopted,
      documents.get(adoptedDocId),
    )
  ) {
    throw new Error("adopted package received a false draft penalty");
  }
  if (
    !hasDraftQualifierForRateEvidence(
      advertisedNarrative,
      documents.get(advertisedDocId),
    )
  ) {
    throw new Error(
      "advertised narrative document did not receive a draft penalty",
    );
  }
  if (adoptedScore <= advertisedScore) {
    throw new Error(
      `expected adopted score to beat advertised score; adopted=${adoptedScore} advertised=${advertisedScore}`,
    );
  }

  const ranked = rerankCurrentStateCandidatesForTest(
    query,
    [advertisedNarrative, currentAdopted],
    documents,
  );
  if (ranked[0].id !== "019f5736-0f82-7310-a4db-c7bbc4806450") {
    throw new Error(
      `expected real FY2027 adopted row first, got ${ranked[0].id}`,
    );
  }
});

Deno.test("current-state budget indicator lookup tiebreak prefers final adopted rate evidence", () => {
  const query = "what is the current real estate tax rate";
  const cexDocId = "00000000-0000-0000-0000-000000000301";
  const summaryDocId = "00000000-0000-0000-0000-000000000302";
  const revenueOverviewDocId = "00000000-0000-0000-0000-000000000303";

  const staleAdoptedTaggedCex = testCandidate(
    "budget_indicators",
    "stale-cex-11225",
    {
      document_id: cexDocId,
      fiscal_year: 2027,
      program: "Real Estate Tax",
      indicator_name: "Real Estate Tax rate",
      value_actual: 1.1225,
      unit: "dollars per $100 of assessed value",
      raw_extracted_text:
        "The FY 2027 Advertised Budget Plan is balanced at the current Real Estate Tax rate of $1.1225 per $100 of assessed value.",
    },
  );
  staleAdoptedTaggedCex.rrfScore = Number.MAX_SAFE_INTEGER;

  const adoptedSummary = testCandidate(
    "budget_indicators",
    "adopted-summary-112",
    {
      document_id: summaryDocId,
      fiscal_year: 2027,
      program: "Real Estate Tax",
      indicator_name: "adopted Real Estate Tax rate",
      value_actual: 1.12,
      unit: "dollars per $100",
      raw_extracted_text:
        "Average residential Real Estate tax bills will increase in FY 2027 based on the adopted Real Estate Tax rate of $1.12 per $100 of assessed value.",
    },
  );
  adoptedSummary.rrfScore = Number.MAX_SAFE_INTEGER;

  const revenueOverview = testCandidate(
    "budget_indicators",
    "revenue-overview-112",
    {
      document_id: revenueOverviewDocId,
      fiscal_year: 2027,
      program: "Real Estate Tax",
      indicator_name: "Real Estate tax rate",
      value_actual: 1.12,
      unit: "dollars per $100 assessed value",
      raw_extracted_text:
        "The decrease is primarily the result of the adoption of a Real Estate tax rate of $1.12 per $100 of assessed value, a 0.25-cent reduction from the advertised rate.",
    },
  );
  revenueOverview.rrfScore = Number.MAX_SAFE_INTEGER;

  const documents = new Map<string, SourceDocument>([
    [cexDocId, {
      id: cexDocId,
      url: "https://example.test/fy2027/adopted/overview/CEX%20Letter.pdf",
      title: null,
      filename: null,
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
    [summaryDocId, {
      id: summaryDocId,
      url:
        "https://example.test/fy2027/adopted/overview/Adopted%20Budget%20Summary.pdf",
      title: null,
      filename: null,
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
    [revenueOverviewDocId, {
      id: revenueOverviewDocId,
      url:
        "https://example.test/fy2027/adopted/overview/General%20Fund%20Revenue%20Overview.pdf",
      title: null,
      filename: null,
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
  ]);

  const selected = selectedCurrentBudgetIndicatorsForTest(
    query,
    [staleAdoptedTaggedCex, adoptedSummary, revenueOverview],
    documents,
  );

  if (selected[0].row.value_actual !== 1.12) {
    throw new Error(
      `expected 1.12 top value, got ${selected[0].row.value_actual}`,
    );
  }
  if (
    selected.slice(0, 2).some((candidate) =>
      candidate.row.value_actual !== 1.12
    )
  ) {
    throw new Error(
      "stale adopted-tagged CEX row outranked final-rate evidence",
    );
  }
});

Deno.test("current-state budget indicator lookup rejects non-rate values from rate pages", () => {
  const docId = "00000000-0000-0000-0000-000000000304";
  const revenueTotal = testCandidate("budget_indicators", "revenue-total", {
    document_id: docId,
    fiscal_year: 2027,
    program: "Affordable Housing Development and Investment",
    indicator_name: "Real Estate Tax rate allocation",
    value_actual: 8788269,
    unit: "dollars",
    raw_extracted_text:
      "The decrease is primarily the result of the adoption of a Real Estate tax rate of $1.12 per $100 of assessed value.",
  });
  const realRate = testCandidate("budget_indicators", "real-rate", {
    document_id: docId,
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate tax rate",
    value_actual: 1.12,
    unit: "dollars per $100 assessed value",
    raw_extracted_text:
      "The decrease is primarily the result of the adoption of a Real Estate tax rate of $1.12 per $100 of assessed value.",
  });
  const documents = new Map<string, SourceDocument>([
    [docId, {
      id: docId,
      url:
        "https://example.test/fy2027/adopted/overview/General%20Fund%20Revenue%20Overview.pdf",
      title: null,
      filename: null,
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
  ]);

  const selected = selectedCurrentBudgetIndicatorsForTest(
    "what is the current real estate tax rate",
    [revenueTotal, realRate],
    documents,
  );

  if (selected.some((candidate) => candidate.id === "revenue-total")) {
    throw new Error("selected a dollar revenue total as a tax-rate answer");
  }
  if (selected[0]?.id !== "real-rate") {
    throw new Error(`expected real rate row first, got ${selected[0]?.id}`);
  }
});

Deno.test("current-value resolver selects adopted structured row before Temporal Judge", () => {
  const query = "what is the current real estate tax rate";
  const adoptedDocId = "00000000-0000-0000-0000-000000000401";
  const advertisedDocId = "00000000-0000-0000-0000-000000000402";
  const adoptedWinner = testCandidate(
    "budget_indicators",
    "adopted-winner",
    {
      document_id: adoptedDocId,
      fiscal_year: 2027,
      program: "Real Estate Tax",
      indicator_name: "adopted Real Estate Tax rate",
      value_actual: 1.12,
      unit: "dollars per $100",
      raw_extracted_text:
        "The adopted Real Estate Tax rate of $1.12 per $100 of assessed value reflects a reduction from $1.1225.",
    },
  );
  const staleNarrative = testCandidate("narrative_chunks", "stale-narrative", {
    document_id: advertisedDocId,
    content:
      "The FY 2028 forecast is based on the current Real Estate tax rate of $1.1225 per $100 of assessed value.",
  });
  const other = testCandidate("budget_indicators", "other-rate", {
    document_id: advertisedDocId,
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.1225,
    unit: "dollars per $100 of assessed value",
    raw_extracted_text:
      "The FY 2027 Advertised Budget Plan is balanced at the current Real Estate Tax rate of $1.1225 per $100 of assessed value.",
  });

  const documents = new Map<string, SourceDocument>([
    [adoptedDocId, {
      id: adoptedDocId,
      url:
        "https://example.test/fy2027/adopted/overview/Adopted%20Budget%20Summary.pdf",
      title: null,
      filename: null,
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
    [advertisedDocId, {
      id: advertisedDocId,
      url: "https://example.test/fy2027/advertised/overview/Multi%20Year.pdf",
      title: null,
      filename: null,
      ingested_at: "2026-07-09T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
  ]);

  const resolved = resolveDeterministicCurrentValue(
    query,
    [staleNarrative, other, adoptedWinner],
    documents,
  );

  if (resolved?.id !== "adopted-winner") {
    throw new Error(
      `expected adopted winner to resolve directly, got ${resolved?.id}`,
    );
  }
});

Deno.test("current-state narrative extraction identifies real transient occupancy tax increase chunk without bypass", () => {
  const revenueOverviewDocId = "019f4747-3a67-7e01-bdb9-c186ec35fcd0";
  const staleDocId = "019f7e45-6930-7ee8-b56a-089cb78d4697";
  const currentTot = testCandidate(
    "narrative_chunks",
    "019f4747-ee4b-7089-bcaf-4498bef4c586",
    {
      document_id: revenueOverviewDocId,
      content:
        "In FY 2026, TOT receipts are projected to increase 48.3 percent, which is primarily associated with a 2-percentage point increase in the FY 2026 TOT tax rate from 4 percent to 6 percent approved by the Board of Supervisors. Transient Occupancy Taxes are charged as part of a hotel bill and remitted by the hotel to the County. The Transient Occupancy Tax had been levied at 4 percent. Actual FY 2025 collections increased over the previous year as business travel continued to recover and hotel average daily rates increased. The remaining discussion covers revenue allocation assumptions, tourism promotion funding, visitor activity, and other General Fund planning context separate from the rate change sentence. Tourism-fund allocations were proposed in a separate planning discussion later in the document.",
    },
  );
  currentTot.rrfScore = 0.01;

  const staleTot = testCandidate(
    "narrative_chunks",
    "019f7e45-b2cd-706b-84de-2591108fa2bc",
    {
      document_id: staleDocId,
      content:
        "Transient Occupancy Tax ($25.6 million) Fairfax County currently levies a 4% transient occupancy tax (2% for general purposes and 2% to promote tourism). The Transient Occupancy Tax rate has not been adjusted since 2004. Public hearing, approval by the Board of Supervisors and ordinance change Rates between 2 and 5% are earmarked for tourism promotion.",
    },
  );
  staleTot.rrfScore = 0.03;

  const documents = new Map<string, SourceDocument>([
    [revenueOverviewDocId, {
      id: revenueOverviewDocId,
      url:
        "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/advertised/overview/General%20Fund%20Revenue%20Overview.pdf",
      title: null,
      filename: null,
      ingested_at: "2026-07-09T14:27:58.183+00:00",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
    [staleDocId, {
      id: staleDocId,
      url:
        "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2024/sep-17/2024_Sept_17_BudgetComm_TaxingAuthority_Supplemental.pdf",
      title: null,
      filename: null,
      ingested_at: "2026-07-20T06:45:05.968+00:00",
      doc_type: "bos_minutes",
      source_published_at: null,
      fiscal_year: null,
    }],
  ]);

  const extracted = extractCurrentValueFromNarrative(
    "what is the current transient occupancy tax rate",
    currentTot,
  );
  if (extracted !== "6 percent") {
    throw new Error(
      `expected real current TOT narrative chunk to extract 6 percent, got ${extracted}`,
    );
  }
  const resolved = resolveDeterministicCurrentValue(
    "what is the current transient occupancy tax rate",
    [staleTot, currentTot],
    documents,
  );
  if (resolved !== null) {
    throw new Error(
      `expected narrative-only current value to fall through Judge/Drafter, got ${resolved.id}`,
    );
  }
});

Deno.test("pure historical tax rate query remains historical-only", () => {
  const oldMarkup = testCandidate("budget_indicators", "real-estate-fy2020", {
    document_id: "old-doc",
    fiscal_year: 2020,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.15,
    raw_extracted_text: "FY 2020 Adopted tax rate $1.15.",
  });
  oldMarkup.rrfScore = 0.03;

  const currentAdopted = testCandidate(
    "budget_indicators",
    "real-estate-fy2027",
    {
      document_id: "current-doc",
      fiscal_year: 2027,
      program: "Real Estate Tax",
      indicator_name: "Real Estate Tax rate",
      value_actual: 1.12,
      raw_extracted_text: "FY 2027 Adopted tax rate $1.12.",
    },
  );
  currentAdopted.rrfScore = 0.01;

  const query = "what was the tax rate in 2020?";
  const ranked = rerankCurrentStateCandidatesForTest(
    query,
    [oldMarkup, currentAdopted],
    new Map(),
  );

  if (!isHistoricalOnlyQuery(query)) {
    throw new Error("pure historical tax-rate query was not historical-only");
  }
  if (ranked[0].id !== "real-estate-fy2020") {
    throw new Error(`expected historical row first, got ${ranked[0].id}`);
  }
});

Deno.test("current-state budget indicator lookup selects current personal property tax rate", () => {
  const adoptedDocId = "00000000-0000-0000-0000-000000000222";
  const staleDocId = "00000000-0000-0000-0000-000000000221";
  const currentPersonalProperty = testCandidate(
    "budget_indicators",
    "personal-property-fy2027-adopted",
    {
      document_id: adoptedDocId,
      fiscal_year: 2027,
      program: "Personal Property Tax",
      indicator_name: "Personal Property Tax rate",
      value_actual: 4.57,
      unit: "dollars per $100 assessed value",
      raw_extracted_text:
        "FY 2027 Adopted Budget: Personal Property Tax rate is $4.57 per $100.",
    },
  );
  const stalePersonalProperty = testCandidate(
    "budget_indicators",
    "personal-property-1993",
    {
      document_id: staleDocId,
      fiscal_year: 1994,
      program: "Personal Property Tax",
      indicator_name: "Personal Property Tax rate",
      value_actual: 4.57,
      unit: "dollars per $100 assessed value",
      raw_extracted_text:
        "1993 BOS summary: Personal Property Tax rate is $4.57 per $100.",
    },
  );
  const realEstate = testCandidate("budget_indicators", "real-estate", {
    document_id: adoptedDocId,
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.12,
    raw_extracted_text: "FY 2027 Adopted Budget Real Estate Tax rate.",
  });

  const documents = new Map<string, SourceDocument>([
    [adoptedDocId, {
      id: adoptedDocId,
      url: "https://example.test/fy2027/adopted/general-fund-revenue.pdf",
      title: "FY 2027 Adopted General Fund Revenue Overview",
      filename: "FY2027_Adopted_General_Fund_Revenue_Overview.pdf",
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: "2026-05-05",
      fiscal_year: 2027,
    }],
    [staleDocId, {
      id: staleDocId,
      url: "https://example.test/1993-bos-summary.pdf",
      title: "1993 Board Summary",
      filename: "1993_BOS_Summary.pdf",
      ingested_at: "2026-07-01T00:00:00Z",
      doc_type: "bos_summary",
      source_published_at: "1993-04-01",
      fiscal_year: 1994,
    }],
  ]);

  const resolved = resolveDeterministicCurrentValue(
    "what is the current personal property tax rate",
    [stalePersonalProperty, realEstate, currentPersonalProperty],
    documents,
  );

  if (resolved?.id !== "personal-property-fy2027-adopted") {
    throw new Error(
      `expected current personal property first, got ${resolved?.id}`,
    );
  }
});

Deno.test("current-value resolver handles known current tax cases as one suite", () => {
  const adoptedDocId = "00000000-0000-0000-0000-000000000601";
  const narrativeDocId = "00000000-0000-0000-0000-000000000602";
  const documents = new Map<string, SourceDocument>([
    [adoptedDocId, {
      id: adoptedDocId,
      url: "https://example.test/fy2027/adopted/fy2027-adopted-package.pdf",
      title: "FY 2027 Adopted Package",
      filename: "fy2027-adopted-package.pdf",
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
    [narrativeDocId, {
      id: narrativeDocId,
      url:
        "https://example.test/fy2027/adopted/general-fund-revenue-overview.pdf",
      title: "FY 2027 Adopted General Fund Revenue Overview",
      filename: "General Fund Revenue Overview.pdf",
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
  ]);

  const cases = [
    {
      query: "what is the current real estate tax rate",
      expectedId: "real-estate-current",
      expectedValue: 1.12,
    },
    {
      query: "what is the current personal property tax rate",
      expectedId: "personal-property-current",
      expectedValue: 4.57,
    },
  ];

  const candidates = [
    testCandidate("budget_indicators", "real-estate-current", {
      document_id: adoptedDocId,
      fiscal_year: 2027,
      program: "Real Estate Tax",
      indicator_name: "Real Estate Tax rate",
      value_actual: 1.12,
      unit: "dollars per $100 of assessed value",
      raw_extracted_text:
        "The Real Estate Tax rate to be approved by the Board will decrease from $1.1225 per $100 of assessed value to $1.12 per $100 of assessed value.",
    }),
    testCandidate("budget_indicators", "personal-property-current", {
      document_id: adoptedDocId,
      fiscal_year: 2027,
      program: "Personal Property Tax",
      indicator_name: "Personal Property Tax rate",
      value_actual: 4.57,
      unit: "dollars per $100 of assessed value",
      raw_extracted_text:
        "The Personal Property Tax rate will remain at $4.57 per $100 of assessed value for most classes of personal property.",
    }),
    testCandidate("narrative_chunks", "tot-current", {
      document_id: narrativeDocId,
      content:
        "In FY 2026, TOT receipts are projected to increase 48.3 percent, primarily associated with a 2-percentage point increase in the FY 2026 TOT tax rate from 4 percent to 6 percent approved by the Board of Supervisors. Transient Occupancy Taxes are charged as part of a hotel bill.",
    }),
  ];

  for (const testCase of cases) {
    const resolved = resolveDeterministicCurrentValue(
      testCase.query,
      candidates,
      documents,
    );
    if (resolved?.id !== testCase.expectedId) {
      throw new Error(
        `${testCase.query}: expected ${testCase.expectedId}, got ${resolved?.id}`,
      );
    }
    const value = resolved.table === "budget_indicators"
      ? resolved.row.value_actual
      : extractCurrentValueFromNarrative(testCase.query, resolved);
    if (value !== testCase.expectedValue) {
      throw new Error(
        `${testCase.query}: expected ${testCase.expectedValue}, got ${value}`,
      );
    }
  }

  const narrativeOnlyResolved = resolveDeterministicCurrentValue(
    "what is the current transient occupancy tax rate",
    candidates,
    documents,
  );
  if (narrativeOnlyResolved !== null) {
    throw new Error(
      `expected narrative-only current tax case to fall through, got ${narrativeOnlyResolved.id}`,
    );
  }
  const narrativeValue = extractCurrentValueFromNarrative(
    "what is the current transient occupancy tax rate",
    candidates[2],
  );
  if (narrativeValue !== "6 percent") {
    throw new Error(
      `expected narrative extraction to remain available, got ${narrativeValue}`,
    );
  }
});

Deno.test("formatBudgetValue formats structured current-value facts", () => {
  if (
    formatBudgetValue(1.12, "dollars per $100 of assessed value") !==
      "$1.12 per $100 of assessed value"
  ) {
    throw new Error("expected per-$100 dollar rate formatting");
  }
  if (formatBudgetValue(6, "percent") !== "6 percent") {
    throw new Error("expected percent formatting");
  }
  if (
    formatBudgetValue("4.57", "dollars per $100 assessed value") !==
      "$4.57 per $100 assessed value"
  ) {
    throw new Error("expected string numeric dollar-rate formatting");
  }
  if (formatBudgetValue(null, "dollars") !== null) {
    throw new Error("expected null for missing structured value");
  }
});

Deno.test("deterministicCurrentValueDraft builds structured and narrative answers with citations", () => {
  const structuredDocId = "00000000-0000-0000-0000-000000000611";
  const narrativeDocId = "00000000-0000-0000-0000-000000000612";
  const documents = new Map<string, SourceDocument>([
    [structuredDocId, {
      id: structuredDocId,
      url: "https://example.test/fy2027/adopted/rates.pdf",
      title: "FY 2027 Adopted Rates",
      filename: "rates.pdf",
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: 2027,
    }],
    [narrativeDocId, {
      id: narrativeDocId,
      url: "https://example.test/fy2027/adopted/revenue.pdf",
      title: "FY 2027 Adopted Revenue",
      filename: "revenue.pdf",
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: 2027,
    }],
  ]);
  const structured = testCandidate("budget_indicators", "real-estate-draft", {
    document_id: structuredDocId,
    page_number_start: 12,
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    value_actual: 1.12,
    unit: "dollars per $100 of assessed value",
    raw_extracted_text:
      "The FY 2027 Adopted Real Estate Tax rate is $1.12 per $100 of assessed value.",
  });
  const narrative = testCandidate("narrative_chunks", "tot-draft", {
    document_id: narrativeDocId,
    page_number_start: 8,
    content:
      "In FY 2026, the TOT tax rate increased from 4 percent to 6 percent approved by the Board of Supervisors. Transient Occupancy Taxes are charged as part of a hotel bill.",
  });

  const structuredDraft = deterministicCurrentValueDraft(
    "what is the current real estate tax rate",
    structured,
    documents,
  );
  if (
    !structuredDraft?.answer.includes(
      "Real Estate Tax is $1.12 per $100 of assessed value.",
    )
  ) {
    throw new Error(`unexpected structured draft: ${structuredDraft?.answer}`);
  }
  if (structuredDraft.answer.includes("source-date review")) {
    throw new Error(
      "structured deterministic draft should not carry narrative source-date caveat",
    );
  }
  if (structuredDraft.citations[0]?.source_title !== "FY 2027 Adopted Rates") {
    throw new Error(
      "structured draft citation did not use source document title",
    );
  }

  const narrativeDraft = deterministicCurrentValueDraft(
    "what is the current transient occupancy tax rate",
    narrative,
    documents,
  );
  if (
    !narrativeDraft?.answer.includes("transient occupancy tax is 6 percent.")
  ) {
    throw new Error(`unexpected narrative draft: ${narrativeDraft?.answer}`);
  }
  if (!narrativeDraft.answer.includes("source-date review")) {
    throw new Error(
      "narrative deterministic draft must carry source-date caveat",
    );
  }
  if (narrativeDraft.citations[0]?.page_number !== 8) {
    throw new Error("narrative draft citation did not preserve page number");
  }
});

Deno.test("narrative current-value extraction rejects proposed future rates", () => {
  const proposed = testCandidate("narrative_chunks", "tot-proposed", {
    content:
      "Staff discussed a proposal to raise the transient occupancy tax from 6 percent to 8 percent; the FY2028 advertised plan to be approved after public hearings.",
  });

  const extracted = extractCurrentValueFromNarrative(
    "what is the current transient occupancy tax rate",
    proposed,
  );
  if (extracted !== null) {
    throw new Error(
      `expected proposed future rate to be rejected, got ${extracted}`,
    );
  }
});

Deno.test("narrative current-value extraction does not bridge historical from-to pairs to unrelated current language", () => {
  const historical = testCandidate(
    "narrative_chunks",
    "tot-historical-bridge",
    {
      content:
        "In 2015 the rate went from 5 percent to 6 percent. The county currently levies a separate meals tax rate.",
    },
  );

  const extracted = extractCurrentValueFromNarrative(
    "what is the current transient occupancy tax rate",
    historical,
  );
  if (extracted !== null) {
    throw new Error(
      `expected unrelated current language to be rejected, got ${extracted}`,
    );
  }
});

Deno.test("narrative current-value extraction stays scoped to the query subject", () => {
  const mixed = testCandidate("narrative_chunks", "mixed-rates", {
    content:
      "The current real estate tax rate is $1.12 per $100 of assessed value. The stormwater services rate remains $0.0325 per $100 of assessed value under the adopted budget.",
  });

  const extracted = extractCurrentValueFromNarrative(
    "what is the current stormwater rate",
    mixed,
  );
  if (extracted !== "$0.0325 per $100 of assessed value") {
    throw new Error(`expected stormwater rate, got ${extracted}`);
  }
});

Deno.test("current-value resolver handles sampled adopted budget indicator rows", () => {
  const adoptedDocId = "00000000-0000-0000-0000-000000000701";
  const documents = new Map<string, SourceDocument>([
    [adoptedDocId, {
      id: adoptedDocId,
      url:
        "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/adopted/overview/Summary%20of%20Non-General%20Fund%20Tax%20Rates.pdf",
      title: "Summary of Non-General Fund Tax Rates",
      filename: "Summary of Non-General Fund Tax Rates.pdf",
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
  ]);
  const sharedText =
    "SUMMARY OF SELECTED NON-GENERAL FUND TAX RATES FY 2018 - FY 2027. FY 2027 Adopted values include Sewer Charge (per 1,000 gal.) $9.88, Leaf Collection (Fund 40130) $0.019, Refuse Disposal per ton (Fund 40150) $98, Commercial & Industrial Tax for Transportation Projects (Fund 40010) $0.125, and Stormwater Services (Fund 40100) $0.0325 per $100 of assessed value.";
  const candidates = [
    testCandidate("budget_indicators", "commercial-industrial-tax", {
      document_id: adoptedDocId,
      fiscal_year: 2027,
      program:
        "Commercial & Industrial Tax for Transportation Projects (Fund 40010)",
      indicator_name: "Commercial & Industrial Tax for Transportation Projects",
      value_actual: 0.125,
      unit: "dollars per $100 of assessed value",
      raw_extracted_text: sharedText,
    }),
    testCandidate("budget_indicators", "leaf-collection", {
      document_id: adoptedDocId,
      fiscal_year: 2027,
      program: "Leaf Collection (Fund 40130)",
      indicator_name: "Leaf Collection",
      value_actual: 0.019,
      unit: "dollars per $100 of assessed value",
      raw_extracted_text: sharedText,
    }),
    testCandidate("budget_indicators", "refuse-disposal", {
      document_id: adoptedDocId,
      fiscal_year: 2027,
      program: "Refuse Disposal per ton (Fund 40150)",
      indicator_name: "Refuse Disposal per ton",
      value_actual: 98,
      unit: "dollars",
      raw_extracted_text: sharedText,
    }),
    testCandidate("budget_indicators", "stormwater-rate", {
      document_id: adoptedDocId,
      fiscal_year: 2027,
      program: "Stormwater Program",
      indicator_name: "Stormwater rate per $100 of assessed value",
      value_actual: 0.0325,
      unit: "dollars",
      raw_extracted_text:
        "The FY 2027 rate remains the same as the FY 2026 Adopted Budget Plan level of $0.0325 per $100 of assessed value.",
    }),
    testCandidate("budget_indicators", "sewer-service-charge", {
      document_id: adoptedDocId,
      fiscal_year: 2027,
      program: "Sewer Service Charges",
      indicator_name: "Sewer Service Charge Per 1,000 gallons of water",
      value_actual: 9.88,
      unit: "dollars",
      raw_extracted_text:
        "The Sewer Service Charge increased from $9.33 to $9.88 per 1,000 gallons of water consumed.",
    }),
  ];

  const cases = [
    [
      "what is the current commercial industrial tax for transportation projects",
      "commercial-industrial-tax",
      0.125,
    ],
    ["what is the current leaf collection rate", "leaf-collection", 0.019],
    ["what is the current refuse disposal per ton rate", "refuse-disposal", 98],
    ["what is the current stormwater rate", "stormwater-rate", 0.0325],
    [
      "what is the current sewer service charge per 1000 gallons",
      "sewer-service-charge",
      9.88,
    ],
  ] as const;

  for (const [query, expectedId, expectedValue] of cases) {
    const resolved = resolveDeterministicCurrentValue(
      query,
      candidates,
      documents,
    );
    if (resolved?.id !== expectedId) {
      throw new Error(`${query}: expected ${expectedId}, got ${resolved?.id}`);
    }
    if (resolved.row.value_actual !== expectedValue) {
      throw new Error(
        `${query}: expected ${expectedValue}, got ${resolved.row.value_actual}`,
      );
    }
  }
});

Deno.test("current-value resolver does not answer fee queries from expenditure rows", () => {
  const adoptedDocId = "00000000-0000-0000-0000-000000000711";
  const documents = new Map<string, SourceDocument>([
    [adoptedDocId, {
      id: adoptedDocId,
      url: "https://example.test/fy2027/adopted/volume2/40140.pdf",
      title: "FY 2027 Adopted Refuse Collection",
      filename: "40140.pdf",
      ingested_at: "2026-07-12T00:02:42.04Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: 2027,
    }],
  ]);
  const expenditure = testCandidate("budget_indicators", "refuse-expenditure", {
    document_id: adoptedDocId,
    fiscal_year: 2027,
    program: "Refuse Collection and Recycling Operations",
    indicator_name: "Expenditures",
    value_actual: 28644210,
    unit: "dollars",
    raw_extracted_text:
      "Refuse Collection and Recycling Operations expenditures total $28,644,210.",
  });
  const fee = testCandidate("budget_indicators", "refuse-fee", {
    document_id: adoptedDocId,
    fiscal_year: 2027,
    program: "Refuse Collection and Recycling Operations",
    indicator_name: "collection rate",
    value_actual: 630,
    unit: "dollars per home",
    raw_extracted_text:
      "The FY 2027 adopted refuse collection rate is $630 per home.",
  });

  const resolved = resolveDeterministicCurrentValue(
    "what is the current refuse collection fee",
    [expenditure, fee],
    documents,
  );

  if (resolved?.id !== "refuse-fee") {
    throw new Error(`expected refuse fee row, got ${resolved?.id}`);
  }
});

Deno.test("current-value resolver ignores future-year projections for current questions", () => {
  const docId = "00000000-0000-0000-0000-000000000801";
  const documents = new Map<string, SourceDocument>([
    [docId, {
      id: docId,
      url: "https://example.test/fy2027/adopted/volume2/69000.pdf",
      title: "FY 2027 Adopted Wastewater Overview",
      filename: "69000.pdf",
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      source_published_at: null,
      fiscal_year: null,
    }],
  ]);
  const current = testCandidate("budget_indicators", "sewer-fy2027", {
    document_id: docId,
    fiscal_year: 2027,
    program: "Sewer Service",
    indicator_name: "Sewer Service Charge Per 1,000 gallons of water",
    value_actual: 9.88,
    unit: "dollars",
    raw_extracted_text:
      "2027 $9.88 2028 $10.78 2029 $11.75 2030 $12.81 2031 $13.69.",
  });
  const future = testCandidate("budget_indicators", "sewer-fy2031", {
    document_id: docId,
    fiscal_year: 2031,
    program: "Sewer Service",
    indicator_name: "Sewer Service Charge Per 1,000 gallons of water",
    value_actual: 13.69,
    unit: "dollars",
    raw_extracted_text:
      "2027 $9.88 2028 $10.78 2029 $11.75 2030 $12.81 2031 $13.69.",
  });
  const priorAdopted = testCandidate("budget_indicators", "sewer-fy2026", {
    document_id: docId,
    fiscal_year: 2026,
    program: "Sewer Service",
    indicator_name: "Sewer Service Charge Per 1,000 gallons of water",
    value_actual: 9.33,
    unit: "dollars",
    raw_extracted_text:
      "The FY 2026 Adopted Sewer Service Charge was $9.33 per 1,000 gallons of water consumed.",
  });

  const resolved = resolveDeterministicCurrentValue(
    "what is the current sewer service charge per 1000 gallons",
    [future, current],
    documents,
  );

  if (resolved?.id !== "sewer-fy2027") {
    throw new Error(`expected FY2027 current row, got ${resolved?.id}`);
  }

  const rolloverResolved = resolveDeterministicCurrentValue(
    "what is the current sewer service charge per 1000 gallons",
    [future, priorAdopted],
    documents,
  );

  if (rolloverResolved?.id !== "sewer-fy2026") {
    throw new Error(
      `expected latest adopted FY at or before current FY, got ${rolloverResolved?.id}`,
    );
  }
});

Deno.test("current-state rerank does not override explicit historical tax-rate queries", () => {
  const oldMarkup = testCandidate("budget_indicators", "old-markup", {
    document_id: "old-doc",
    fiscal_year: 2025,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    raw_extracted_text: "FY 2025 Budget Mark-Up tax rate $1.125.",
  });
  oldMarkup.rrfScore = 0.03;

  const currentAdopted = testCandidate("budget_indicators", "fy2027-adopted", {
    document_id: "new-doc",
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "Real Estate Tax rate",
    raw_extracted_text: "FY 2027 Adopted tax rate $1.12.",
  });
  currentAdopted.rrfScore = 0.01;

  const ranked = rerankCurrentStateCandidatesForTest(
    "what was the tax rate in 2024",
    [oldMarkup, currentAdopted],
    new Map(),
  );

  if (ranked[0].id !== "old-markup") {
    throw new Error(
      `expected historical query to preserve retrieval order, got ${
        ranked[0].id
      }`,
    );
  }
});

// ── §5.2.1 narrative-currency guard (Wave 2a) ────────────────────────────────
// Bound to the SHIPPING exports (filterUncurrentNarrativeValues,
// narrativeMakesCurrentValueClaim, narrativeCurrentValueHasStaleProvenance,
// resolveDeterministicCurrentValue — imported from ./index.ts at the top of this
// file), NOT to local copies. A mutation to any of those shipping functions must
// break these tests.
//
// The two TOT fixtures below use content pulled VERBATIM from Supabase project
// ahaurkifxzqsrhwjshbj (chunk ids preserved), so they exercise the guard against
// the exact data the Fable audit flagged.

// Verbatim live content — narrative_chunks.content for the two audit chunks.
const REAL_STALE_TOT_ID = "019f7e45-b2cd-706b-84de-2591108fa2bc";
const REAL_STALE_TOT_DOC = "019f7e45-6930-7ee8-b56a-089cb78d4697";
const REAL_STALE_TOT_CONTENT =
  "max=$10.2 million; at state maximum rates=$98 million (Based on FY 2025 projection) Transient Occupancy Tax ($25.6 million) Fairfax County currently levies a 4% transient occupancy tax (2% for general purposes and 2% to promote tourism). The Transient Occupancy Tax rate has not been adjusted since 2004. Public hearing, approval by the Board of Supervisors and ordinance change Rates between 2 and 5% are earmarked for tourism promotion. No restriction on the tax rate above 5% 1% = $6.4 million based on FY 2025 estimated revenue Taxes With No Rate Flexibility Revenue Category (FY 2025 Revenue Estimate) Information Action Required Rate Limitations Potential Revenue Local Option Sales and Use Tax ($246.4 million) Maximum 1% local option rate set by the state N/A 1% N/A Cigarette Tax ($5.2 million at the FY 2025 tax rate of 40 cents per pack of 20 cigarettes)";

const REAL_CURRENT_TOT_ID = "019f4747-ee4b-7089-bcaf-4498bef4c586";
const REAL_CURRENT_TOT_DOC = "019f4747-3a67-7e01-bdb9-c186ec35fcd0";
const REAL_CURRENT_TOT_CONTENT =
  "However, the FY 2022 level was still well below the pre-pandemic collections, as business travel was slow to recover. FY 2023 collections continued to have a robust recovery, increasing a strong 42.2 percent compared to FY 2022 and bringing the collections back to near pre-pandemic level. Actual FY 2024 receipts increased 12.1 percent, surpassing the pre-pandemic collection levels, primarily as a result of higher hotel average daily rates (ADR) and higher hotel occupancy. Actual FY 2025 collections increased 5.7 percent over the previous year. In FY 2026, TOT receipts are projected to increase 48.3 percent, which is primarily associated with a 2-percentage point increase in the FY 2026 TOT tax rate from 4 percent to 6 percent approved by the Board of Supervisors. Transient Occupancy Taxes are charged as part of a hotel bill and remitted by the hotel to the County. The Transient Occupancy Tax had been levied at 4 percent since the Virginia  General  Assembly  permitted  the  Board  of  Supervisors  to  levy  an  additional  2.0  percent Transient Occupancy Tax in FY 2005.";

function realStaleTotCandidate(): EnrichedCandidate {
  return testCandidate("narrative_chunks", REAL_STALE_TOT_ID, {
    document_id: REAL_STALE_TOT_DOC,
    content: REAL_STALE_TOT_CONTENT,
  });
}
function realCurrentTotCandidate(): EnrichedCandidate {
  return testCandidate("narrative_chunks", REAL_CURRENT_TOT_ID, {
    document_id: REAL_CURRENT_TOT_DOC,
    content: REAL_CURRENT_TOT_CONTENT,
  });
}
// doc_type/budget_stage/source_published_at/fiscal_year also copied live.
function realStaleTotDoc(): SourceDocument {
  return {
    id: REAL_STALE_TOT_DOC,
    url:
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2024/sep-17/2024_Sept_17_BudgetComm_TaxingAuthority_Supplemental.pdf",
    title: null,
    filename: null,
    ingested_at: "2026-07-20T06:45:05.968+00:00",
    doc_type: "bos_minutes",
    budget_stage: null,
    source_published_at: "2024-09-17",
    fiscal_year: null,
  };
}
function realCurrentTotDoc(): SourceDocument {
  return {
    id: REAL_CURRENT_TOT_DOC,
    url:
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/advertised/overview/General%20Fund%20Revenue%20Overview.pdf",
    title: null,
    filename: null,
    ingested_at: "2026-07-09T14:27:58.183+00:00",
    doc_type: "budget_pdf",
    budget_stage: "advertised",
    source_published_at: null,
    fiscal_year: 2027,
  };
}

// The core proof (review PROOF STANDARD): against the two real chunks, the stale
// 4% chunk is filtered and the Board-approved 6% chunk is kept for a current
// query. This is the exact failure the reviewer reproduced against live data.
Deno.test("§5.2.1 guard (real chunks): stale 4% TOT filtered, Board-approved 6% kept", () => {
  const query = "what is the current transient occupancy tax rate";
  const stale = realStaleTotCandidate();
  const current = realCurrentTotCandidate();
  const documents = new Map<string, SourceDocument>([
    [REAL_STALE_TOT_DOC, realStaleTotDoc()],
    [REAL_CURRENT_TOT_DOC, realCurrentTotDoc()],
  ]);

  const kept = filterUncurrentNarrativeValues(
    query,
    [stale, current],
    documents,
  )
    .map((c) => c.id);
  if (kept.includes(REAL_STALE_TOT_ID)) {
    throw new Error(
      `real stale 4% chunk must be filtered for a current query, kept: ${
        kept.join(", ")
      }`,
    );
  }
  if (!kept.includes(REAL_CURRENT_TOT_ID)) {
    throw new Error(
      `real Board-approved 6% chunk must be kept, kept: ${kept.join(", ")}`,
    );
  }
});

// BLOCKING 1 regression: the classifier must recognize the stale chunk's explicit
// "currently levies a 4%" assertion even though the ranking extractor returns
// null on this exact text. If classification silently regresses to the extractor,
// the chunk is treated as plain context and kept — the original leak.
Deno.test("§5.2.1 classifier recognizes 'currently levies a 4%' where the extractor returns null", () => {
  const query = "what is the current transient occupancy tax rate";
  const stale = realStaleTotCandidate();
  const doc = realStaleTotDoc();
  if (extractCurrentValueFromNarrative(query, stale) !== null) {
    throw new Error(
      "fixture premise changed: the ranking extractor no longer returns null on this chunk",
    );
  }
  if (!narrativeMakesCurrentValueClaim(query, stale, doc)) {
    throw new Error(
      "classifier must flag the explicit 'currently levies a 4%' current-value claim",
    );
  }
});

// BLOCKING 3: an undatable / older non-defensible claim is filtered when a
// positively-dated defensible competitor exists — but kept (caveat path) when it
// is the only current-value evidence.
Deno.test("§5.2.1 guard drops the stale claim only when a positively-dated defensible competitor exists", () => {
  const query = "what is the current transient occupancy tax rate";
  const staleOnly = filterUncurrentNarrativeValues(
    query,
    [realStaleTotCandidate()],
    new Map<string, SourceDocument>([[REAL_STALE_TOT_DOC, realStaleTotDoc()]]),
  ).map((c) => c.id);
  if (!staleOnly.includes(REAL_STALE_TOT_ID)) {
    throw new Error(
      "with no defensible competitor the stale claim must be kept for the caveat path",
    );
  }
  const withCompetitor = filterUncurrentNarrativeValues(
    query,
    [realStaleTotCandidate(), realCurrentTotCandidate()],
    new Map<string, SourceDocument>([
      [REAL_STALE_TOT_DOC, realStaleTotDoc()],
      [REAL_CURRENT_TOT_DOC, realCurrentTotDoc()],
    ]),
  ).map((c) => c.id);
  if (withCompetitor.includes(REAL_STALE_TOT_ID)) {
    throw new Error(
      "with a positively-dated defensible competitor the stale claim must be dropped",
    );
  }
});

// BLOCKING 2: defensibility is POSITIVE currency evidence, not the absence of a
// stale flag. The Board-approved 6% chunk sits in an "advertised" container yet
// must be defensible (its own approval signal), while the stale chunk — which is
// NOT advertised, so an absence-of-stale-flag rule would wrongly call it
// defensible — is not. narrativeCurrentValueHasStaleProvenance is false for both
// (neither is advertised); the drop is driven by positive-evidence + recency.
Deno.test("§5.2.1 guard: Board-approval in an advertised container is defensible; a non-advertised stale claim is not", () => {
  const query = "what is the current transient occupancy tax rate";
  const stale = realStaleTotCandidate();
  const current = realCurrentTotCandidate();
  // Neither chunk is advertised-with-no-approval, so stale-provenance is false
  // for both — proving the drop is NOT a provenance shortcut.
  if (
    narrativeCurrentValueHasStaleProvenance(query, stale, realStaleTotDoc())
  ) {
    throw new Error(
      "stale chunk is not advertised → stale-provenance must be false",
    );
  }
  if (
    narrativeCurrentValueHasStaleProvenance(query, current, realCurrentTotDoc())
  ) {
    throw new Error(
      "Board-approved chunk must not be flagged stale-provenance despite advertised container",
    );
  }
  // The Board-approved chunk alone is always kept (own positive evidence).
  const currentAlone = filterUncurrentNarrativeValues(
    query,
    [current],
    new Map<string, SourceDocument>([[
      REAL_CURRENT_TOT_DOC,
      realCurrentTotDoc(),
    ]]),
  ).map((c) => c.id);
  if (!currentAlone.includes(REAL_CURRENT_TOT_ID)) {
    throw new Error("Board-approved chunk must never be filtered");
  }
});

// The stormwater case from the audit: a rate served as current whose only
// provenance is a "FY 2022 Budget as Advertised" document. Advertised/proposed
// figures must not be asserted as current, so the sole candidate is dropped by
// provenance (rule a) regardless of any competitor.
Deno.test("§5.2.1 guard drops an advertised-only current-value narrative", () => {
  const query = "what is the current stormwater district tax rate";
  const docId = "00000000-0000-0000-0000-0000000005b1";
  const advertised = testCandidate(
    "narrative_chunks",
    "stormwater-advertised",
    {
      document_id: docId,
      content:
        "The FY 2022 Budget as Advertised sets the stormwater service district tax rate at 0.0325 per $100 of assessed value, effective July 1 2021.",
    },
  );
  const documents = new Map<string, SourceDocument>([
    [docId, {
      id: docId,
      url: "https://example.test/fy2022/advertised/stormwater.pdf",
      title: "FY 2022 Advertised Budget Plan",
      filename: null,
      ingested_at: "2026-07-01T00:00:00Z",
      doc_type: "budget_pdf",
      budget_stage: "advertised",
      source_published_at: null,
      fiscal_year: 2022,
    }],
  ]);

  if (
    !narrativeCurrentValueHasStaleProvenance(
      query,
      advertised,
      documents.get(docId),
    )
  ) {
    throw new Error(
      "advertised stormwater narrative should be flagged stale-provenance",
    );
  }
  const kept = filterUncurrentNarrativeValues(query, [advertised], documents)
    .map((c) => c.id);
  if (kept.length !== 0) {
    throw new Error(
      `advertised-only current-value narrative must be dropped, kept: ${
        kept.join(", ")
      }`,
    );
  }
});

// Regression safety: an adopted structured row is never removed and still
// resolves deterministically even when a stale competing narrative is present.
Deno.test("§5.2.1 guard preserves the adopted structured $1.12 row and still resolves it", () => {
  const query = "what is the current real estate tax rate";
  const adoptedDocId = "00000000-0000-0000-0000-0000000005e1";
  const staleDocId = "00000000-0000-0000-0000-0000000005e2";

  const adopted = testCandidate("budget_indicators", "re-adopted", {
    document_id: adoptedDocId,
    fiscal_year: 2027,
    program: "Real Estate Tax",
    indicator_name: "adopted Real Estate Tax rate",
    value_actual: 1.12,
    unit: "dollars per $100",
    raw_extracted_text:
      "The adopted Real Estate Tax rate of $1.12 per $100 of assessed value reflects a reduction from $1.1225.",
  });
  const staleNarrative = testCandidate("narrative_chunks", "re-stale", {
    document_id: staleDocId,
    content:
      "The Real Estate tax rate is $1.15 per $100 of assessed value, remaining at $1.15 for that year.",
  });
  staleNarrative.rrfScore = 0.03;

  const documents = new Map<string, SourceDocument>([
    [adoptedDocId, {
      id: adoptedDocId,
      url:
        "https://example.test/fy2027/adopted/overview/Adopted%20Budget%20Summary.pdf",
      title: null,
      filename: null,
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "budget_pdf",
      budget_stage: "adopted",
      source_published_at: null,
      fiscal_year: 2027,
    }],
    [staleDocId, {
      id: staleDocId,
      url: "https://example.test/fy2020/adopted/overview.pdf",
      title: "FY 2020 Adopted Budget Overview",
      filename: null,
      ingested_at: "2026-07-01T00:00:00Z",
      doc_type: "budget_pdf",
      budget_stage: "adopted",
      source_published_at: "2019-05-07",
      fiscal_year: 2020,
    }],
  ]);

  const curated = filterUncurrentNarrativeValues(
    query,
    [staleNarrative, adopted],
    documents,
  );
  if (!curated.some((c) => c.id === "re-adopted")) {
    throw new Error("adopted structured $1.12 row must never be filtered out");
  }
  if (curated.some((c) => c.id === "re-stale")) {
    throw new Error(
      "stale FY2020 narrative must be dropped when a defensible FY2027 row competes",
    );
  }
  const resolved = resolveDeterministicCurrentValue(query, curated, documents);
  if (resolved?.id !== "re-adopted") {
    throw new Error(
      `adopted $1.12 row must still resolve deterministically, got ${resolved?.id}`,
    );
  }
});

// Historical / compound / deep-historical queries are a no-op: the guard must not
// touch candidate sets for anything but implicit-current questions.
Deno.test("§5.2.1 guard is a no-op for historical and compound queries", () => {
  const documents = new Map<string, SourceDocument>([
    [REAL_STALE_TOT_DOC, realStaleTotDoc()],
  ]);
  for (
    const query of [
      "what was the transient occupancy tax rate in 2020",
      "what is the current transient occupancy tax rate, and what was it in 2020",
    ]
  ) {
    const kept = filterUncurrentNarrativeValues(
      query,
      [realStaleTotCandidate()],
      documents,
    ).map((c) => c.id);
    if (kept.length !== 1 || kept[0] !== REAL_STALE_TOT_ID) {
      throw new Error(
        `guard must not touch candidates for "${query}", kept: ${
          kept.join(", ")
        }`,
      );
    }
  }
});

// BLOCKING 3 (null-recency branch): an UNDATABLE current-value claim (no fiscal
// year, no source_published_at, no date in the URL) must be filtered when a
// positively-dated defensible competitor exists — undatable is not a free pass.
Deno.test("§5.2.1 guard drops an undatable current-value claim against a positively-dated competitor", () => {
  const query = "what is the current transient occupancy tax rate";
  const undatableDocId = "00000000-0000-0000-0000-0000000006a1";
  const undatable = testCandidate("narrative_chunks", "tot-undatable", {
    document_id: undatableDocId,
    content:
      "The transient occupancy tax is currently levied at a rate of 4% on hotel stays in the County.",
  });
  undatable.rrfScore = 0.05;

  const documents = new Map<string, SourceDocument>([
    [undatableDocId, {
      id: undatableDocId,
      url: "https://example.test/reference/tax-glossary.pdf",
      title: "Tax Glossary",
      filename: null,
      ingested_at: "2026-07-20T00:00:00Z",
      doc_type: "bos_summary",
      budget_stage: null,
      source_published_at: null,
      fiscal_year: null,
    }],
    [REAL_CURRENT_TOT_DOC, realCurrentTotDoc()],
  ]);

  // Sanity: the undatable chunk genuinely has no recency signal.
  const undatableAlone = filterUncurrentNarrativeValues(
    query,
    [undatable],
    new Map<string, SourceDocument>([[
      undatableDocId,
      documents.get(undatableDocId)!,
    ]]),
  ).map((c) => c.id);
  if (!undatableAlone.includes("tot-undatable")) {
    throw new Error("undatable claim alone must be kept for the caveat path");
  }

  const kept = filterUncurrentNarrativeValues(
    query,
    [undatable, realCurrentTotCandidate()],
    documents,
  ).map((c) => c.id);
  if (kept.includes("tot-undatable")) {
    throw new Error(
      "undatable claim must be dropped when a positively-dated defensible competitor exists",
    );
  }
  if (!kept.includes(REAL_CURRENT_TOT_ID)) {
    throw new Error("the defensible competitor must be kept");
  }
});

// ── Wave 2b: generalized deterministic ordinance current-value resolver ────────
//
// These tests exercise the SHIPPING functions imported from ./index.ts
// (selectCurrentOrdinanceValueAnchors, extractCurrentValueFromOrdinance) — no
// parallel copies. Fixtures are derived from real live rows in
// ordinance_provisions (Supabase ahaurkifxzqsrhwjshbj), including the exact
// noise BM25's OR-semantics leg returns for the transient-occupancy query.

// Faithful excerpt of the live current §4-13-2 (three additive subsections
// 3% + 2% + 1% = 6%, each stacked "in addition to the tax imposed by subsection").
const REAL_TOT_ORDINANCE_CONTENT =
  "(a) Pursuant to Virginia Code § 58.1-3819, in addition to all other taxes, " +
  "there is hereby imposed and levied a tax equivalent to three percent of the " +
  "total room charge paid by or for any such transient for the use or possession " +
  "of accommodations; provided however, that the tax imposed by this subsection " +
  "will not be imposed on any transient occupancy in any Lodging Facility that is " +
  "located within any town that has imposed a tax on transient occupancy. " +
  "(b) Pursuant to Virginia Code § 58.1-3824, and in addition to the tax imposed " +
  "by subsection a of this Section, in addition to all other taxes, there is " +
  "hereby imposed and levied a tax equivalent to two percent of the total room " +
  "charge paid by or for any such transient for the use or possession of " +
  "accommodations. (c) Pursuant to Virginia Code § 58.1-3819, and in addition to " +
  "the tax imposed by subsections a and b of this Section, in addition to all " +
  "other taxes, there is hereby imposed and levied a tax equivalent to one " +
  "percent of the total room charge. The one percent tax levy shall be spent " +
  "solely for tourism.";

const TOT_NODE_ID = "FACOCO_CH4TAFI_ART13TROCTA_S4-13-2LEAMTA";
const TOT_QUERY = "what is the current transient occupancy tax rate";

function totRawRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "01931234-0000-7000-8000-00000000ab13",
    municode_node_id: TOT_NODE_ID,
    section_title: "Section 4-13-2. - Levy; amount of tax.",
    is_current: true,
    effective_date: "2026-04-28",
    document_id: "00000000-0000-0000-0000-0000000004a1",
    content: REAL_TOT_ORDINANCE_CONTENT,
    ...overrides,
  };
}

// A real is_current zoning section BM25 returns for the TOT query — dozens of
// non-additive percentages, but no "transient occupancy" subject match.
function zoningNoiseRow(): Record<string, unknown> {
  return {
    id: "01931234-0000-7000-8000-0000000022e5",
    municode_node_id: "encode:2245",
    section_title: "Article 5 - Development Standards",
    is_current: true,
    effective_date: "2025-01-01",
    document_id: "00000000-0000-0000-0000-0000000004a2",
    content:
      "Article 5 - Development Standards. Lot, Bulk, and Open Space Regulations: " +
      "25 percent, 50 percent, 125 percent, 20 percent open space; setbacks of " +
      "15 percent and 30 percent apply to affordable dwelling unit programs.",
  };
}

Deno.test("extractCurrentValueFromOrdinance sums the live TOT additive subsections to 6% (sentinel)", () => {
  const value = extractCurrentValueFromOrdinance(
    TOT_QUERY,
    testCandidate("ordinance_provisions", TOT_NODE_ID, {
      is_current: true,
      section_title: "Section 4-13-2. - Levy; amount of tax.",
      content: REAL_TOT_ORDINANCE_CONTENT,
    }),
  );
  if (value !== "6%") {
    throw new Error(`expected 6% for the TOT compound levy, got ${value}`);
  }
});

Deno.test("extractCurrentValueFromOrdinance generalizes off the TOT node: a non-TOT single-rate ordinance yields its value", () => {
  const value = extractCurrentValueFromOrdinance(
    "what is the current meals tax rate",
    testCandidate("ordinance_provisions", "FACOCO-meals-tax", {
      is_current: true,
      section_title: "Section 4-31-2. - Levy; amount of meals tax.",
      content:
        "There is hereby imposed and levied a meals tax at the rate of four " +
        "percent of the amount charged for prepared food and beverages sold in " +
        "the County.",
    }),
  );
  // Old hardcoded gate returned null for anything lacking "transient occupancy".
  if (value !== "4%") {
    throw new Error(`expected 4% for the generalized meals tax, got ${value}`);
  }
});

Deno.test("extractCurrentValueFromOrdinance refuses to sum non-additive multi-percentage sections (precision)", () => {
  // Real §4-31-8 shape: a collection commission with 3% and 1% components that
  // are NOT stacked. Naively summing would fabricate 4%; the additive guard
  // must return null so the caller falls through instead of pinning garbage.
  const value = extractCurrentValueFromOrdinance(
    "what is the current meals tax commission rate",
    testCandidate("ordinance_provisions", "FACOCO-commission", {
      is_current: true,
      section_title:
        "Section 4-31-8. - Commission to seller for collection of tax.",
      content:
        "For the purpose of defraying some of the costs incurred by the seller " +
        "in collecting the meals tax imposed by this Article, every seller who " +
        "collects and remits the tax shall be allowed a commission of three " +
        "percent on the first taxes collected and one percent thereafter.",
    }),
  );
  if (value !== null) {
    throw new Error(
      `expected null (ambiguous non-additive percentages), got ${value}`,
    );
  }
});

Deno.test("selectCurrentOrdinanceValueAnchors pins the real TOT node out of a noisy BM25 pool", () => {
  // Mirrors the live bm25_ordinance_provisions('...transient occupancy tax rate')
  // result: the real §4-13-2 row plus zoning/definition noise and a superseded
  // (is_current=false) TOT version. Only the real current node must survive.
  const supersededTot = totRawRow({
    id: "01931234-0000-7000-8000-00000000ac13",
    is_current: false,
    effective_date: "2005-07-01",
    content: REAL_TOT_ORDINANCE_CONTENT.replace(
      "one percent of the total room charge. The one percent tax levy shall be spent solely for tourism.",
      "an older schedule.",
    ),
  });
  const anchors = selectCurrentOrdinanceValueAnchors(TOT_QUERY, [
    zoningNoiseRow(),
    supersededTot,
    totRawRow(),
  ]);

  if (anchors.length !== 1) {
    throw new Error(
      `expected exactly the current TOT node, got ${anchors.length}: ${
        anchors.map((a) => a.municode_node_id).join(", ")
      }`,
    );
  }
  if (anchors[0].municode_node_id !== TOT_NODE_ID) {
    throw new Error(`wrong node pinned: ${anchors[0].municode_node_id}`);
  }
  if (anchors[0].row.is_current !== true) {
    throw new Error("pinned a non-current row");
  }
  if (extractCurrentValueFromOrdinance(TOT_QUERY, anchors[0]) !== "6%") {
    throw new Error("pinned TOT node does not extract to 6%");
  }
});

Deno.test("selectCurrentOrdinanceValueAnchors falls through (empty) when no row matches the subject", () => {
  const anchors = selectCurrentOrdinanceValueAnchors(TOT_QUERY, [
    zoningNoiseRow(),
  ]);
  if (anchors.length !== 0) {
    throw new Error(
      `expected fall-through on no subject match, got ${anchors.length}`,
    );
  }
});

Deno.test("selectCurrentOrdinanceValueAnchors never pins an is_current=false row", () => {
  const anchors = selectCurrentOrdinanceValueAnchors(TOT_QUERY, [
    totRawRow({ is_current: false }),
  ]);
  if (anchors.length !== 0) {
    throw new Error(
      `is_current=false must never be pinned, got ${anchors.length}`,
    );
  }
});

Deno.test("selectCurrentOrdinanceValueAnchors falls through when two sections disagree on the value (ambiguity guard)", () => {
  const nodeA = {
    id: "01931234-0000-7000-8000-0000000000a1",
    municode_node_id: "FACOCO-widget-a",
    section_title: "Section 4-40-1. - Widget tax.",
    is_current: true,
    effective_date: "2026-01-01",
    document_id: "00000000-0000-0000-0000-0000000004b1",
    content:
      "There is hereby imposed and levied a widget tax at the rate of four " +
      "percent of the widget sales price.",
  };
  const nodeB = {
    id: "01931234-0000-7000-8000-0000000000b2",
    municode_node_id: "FACOCO-widget-b",
    section_title: "Section 4-40-2. - Widget tax (special district).",
    is_current: true,
    effective_date: "2026-02-01",
    document_id: "00000000-0000-0000-0000-0000000004b2",
    content:
      "There is hereby imposed and levied a widget tax at the rate of six " +
      "percent of the widget sales price.",
  };
  const anchors = selectCurrentOrdinanceValueAnchors(
    "what is the current widget tax rate",
    [nodeA, nodeB],
  );
  if (anchors.length !== 0) {
    throw new Error(
      `conflicting sections must fall through, got ${anchors.length}`,
    );
  }
});

Deno.test("selectCurrentOrdinanceValueAnchors respects the query-shape gate", () => {
  // Historical phrasing → not a current-value query → no prefetch.
  const historical = selectCurrentOrdinanceValueAnchors(
    "what was the transient occupancy tax rate in 2020",
    [totRawRow()],
  );
  if (historical.length !== 0) {
    throw new Error(
      `historical query must not prefetch, got ${historical.length}`,
    );
  }
  // Non tax-rate question → no prefetch even against a matching row.
  const nonRate = selectCurrentOrdinanceValueAnchors(
    "who administers the transient occupancy program",
    [totRawRow()],
  );
  if (nonRate.length !== 0) {
    throw new Error(
      `non tax-rate query must not prefetch, got ${nonRate.length}`,
    );
  }
});

Deno.test("deterministicCurrentValueDraft renders the generalized TOT anchor with PR #125 formatting and no narrative caveat", () => {
  const docId = "00000000-0000-0000-0000-0000000004a1";
  const documents = new Map<string, SourceDocument>([
    [docId, {
      id: docId,
      url: "https://example.test/ordinance/4-13-2",
      title: "Fairfax County Code Sec. 4-13-2",
      filename: "ordinance.pdf",
      ingested_at: "2026-05-01T00:00:00Z",
      doc_type: "ordinance",
      source_published_at: null,
      fiscal_year: null,
    }],
  ]);
  const [anchor] = selectCurrentOrdinanceValueAnchors(TOT_QUERY, [totRawRow()]);
  if (!anchor) throw new Error("expected a TOT anchor");

  const draft = deterministicCurrentValueDraft(TOT_QUERY, anchor, documents);
  if (
    !draft?.answer.includes(
      "Per Sec. 4-13-2 (Levy; amount of tax), the current value is 6%.",
    )
  ) {
    throw new Error(`unexpected ordinance draft: ${draft?.answer}`);
  }
  if (draft.answer.includes("source-date review")) {
    throw new Error(
      "structured ordinance draft must not carry the narrative source-date caveat",
    );
  }
});
