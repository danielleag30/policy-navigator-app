/**
 * Unit tests for the RRF merge logic and rate-limit helpers in query-pipeline.
 *
 * Run with:  deno test supabase/functions/query-pipeline/rrf_test.ts
 */

// ── Inline the testable logic (no Deno/Supabase runtime deps) ────────────────

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
  source_published_at: string | null;
  fiscal_year: number | null;
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
  return typeof value === "string" ? value.toLowerCase() : "";
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
  if (
    c.table === "budget_indicators" && isRelevantTaxRateCandidate(query, c, doc)
  ) {
    const fiscalYear = asNumber(c.row.fiscal_year) ?? doc?.fiscal_year ?? 0;
    const adoptedBoost = isAdoptedBudgetSource(c, doc) ? 100 : 0;
    const draftPenalty = hasDraftQualifierForRateEvidence(c, doc) ? -100 : 0;
    return 2_000_000 + adoptedBoost + draftPenalty + fiscalYear +
      budgetIndicatorTiebreakScore(c, doc);
  }

  if (
    c.table === "narrative_chunks" && isRelevantTaxRateCandidate(query, c, doc)
  ) {
    const recencyScore = parseDocumentRecencyScore(doc);
    const adoptedBoost = isAdoptedBudgetSource(c, doc) ? 100 : 0;
    const draftPenalty = hasDraftQualifierForRateEvidence(c, doc) ? -100 : 0;
    return 500 + adoptedBoost + draftPenalty +
      (recencyScore === null ? 0 : recencyScore);
  }

  return 0;
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

function decisiveCurrentBudgetWinnerForTest(
  query: string,
  candidates: EnrichedCandidate[],
  documents: Map<string, SourceDocument>,
): EnrichedCandidate | null {
  if (!isCurrentStateQuery(query)) return null;

  const scored = candidates
    .filter((c) => c.table === "budget_indicators")
    .map((candidate) => {
      const doc = typeof candidate.row.document_id === "string"
        ? documents.get(candidate.row.document_id)
        : undefined;
      return {
        candidate,
        score: currentStateScore(query, candidate, doc),
      };
    })
    .filter(({ score }) => score >= 2_000_000)
    .sort((a, b) =>
      b.score - a.score || b.candidate.rrfScore - a.candidate.rrfScore
    );

  if (scored.length === 0) return null;
  const [top, runnerUp] = scored;
  if (runnerUp && top.score - runnerUp.score < 100) return null;
  return top.candidate;
}

function pinCurrentBudgetWinnerForTest(
  filteredCandidates: EnrichedCandidate[],
  pinned: EnrichedCandidate | null,
): EnrichedCandidate[] {
  if (!pinned) return filteredCandidates;
  const withoutPinned = filteredCandidates.filter((c) => c.key !== pinned.key);
  return [pinned, ...withoutPinned].slice(0, JUDGE_OUTPUT_LIMIT);
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

function citationByChunkId(citations: CitationChunk[]): Map<string, string> {
  return new Map(citations.map((citation) => [
    citation.chunk_id,
    citation.formatted,
  ]));
}

function formatInlineAnswerCitations(
  answer: string,
  citations: CitationChunk[],
): string {
  const labels = citationByChunkId(citations);
  return answer.replace(
    /\[chunk_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12});[^\n]*?\](?:\])?/gi,
    (raw, chunkId: string) => labels.get(chunkId) ?? raw,
  );
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

Deno.test("current-state budget winner is pinned when Temporal Judge omits it", () => {
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

  const pinned = decisiveCurrentBudgetWinnerForTest(
    query,
    [staleNarrative, other, adoptedWinner],
    documents,
  );
  const filtered = pinCurrentBudgetWinnerForTest([staleNarrative], pinned);

  if (pinned?.id !== "adopted-winner") {
    throw new Error(
      `expected adopted winner to be decisive, got ${pinned?.id}`,
    );
  }
  if (filtered[0]?.id !== "adopted-winner") {
    throw new Error(`expected pinned winner first, got ${filtered[0]?.id}`);
  }
  if (
    filtered.some((candidate) => candidate.id === "adopted-winner") === false
  ) {
    throw new Error("pinned winner was not restored after judge omission");
  }
});

Deno.test("current-state narrative recency selects real transient occupancy tax increase chunk", () => {
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

  const ranked = rerankCurrentStateCandidatesForTest(
    "what is the current transient occupancy tax rate",
    [staleTot, currentTot],
    documents,
  );

  if (ranked[0].id !== "019f4747-ee4b-7089-bcaf-4498bef4c586") {
    throw new Error(
      `expected real current TOT narrative chunk first, got ${ranked[0].id}`,
    );
  }
  if (!String(ranked[0].row.content).includes("6 percent")) {
    throw new Error(
      "expected selected TOT narrative chunk to support 6 percent",
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

  const selected = selectedCurrentBudgetIndicatorsForTest(
    "what is the current personal property tax rate",
    [stalePersonalProperty, realEstate, currentPersonalProperty],
    documents,
  );

  if (selected[0]?.id !== "personal-property-fy2027-adopted") {
    throw new Error(
      `expected current personal property first, got ${selected[0]?.id}`,
    );
  }
  if (selected.some((candidate) => candidate.id === "personal-property-1993")) {
    throw new Error("selected stale 1993 personal property tax row");
  }
  if (selected.some((candidate) => candidate.id === "real-estate")) {
    throw new Error("personal property query selected real estate tax row");
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
