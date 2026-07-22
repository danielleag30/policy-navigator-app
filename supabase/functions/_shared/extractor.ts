/**
 * LLM-based structured extraction module (task 2-4).
 *
 * Processes each document chunk through Ollama Cloud and persists structured
 * rows to vote_tallies, policy_decisions, budget_indicators, or narrative_chunks.
 *
 * Design constraints:
 * - Temperature 0.1 for all extraction calls (deterministic structured output)
 * - Falls back to narrative_chunks for any chunk with no extraction result
 * - NEVER exposes stack traces; all errors are logged internally
 * - Uses ollamaChat() from ./ollama-client.ts (no tools param, /api/chat endpoint)
 * - Does NOT import chunker.ts — defines its own ChunkLike to avoid transitive
 *   dep on @xenova/transformers in the bundler graph.
 * - Does NOT set documents.status — finalization is task 2-6's responsibility.
 */

import { generate as uuidv7 } from "@std/uuid/v7";
import { ollamaChat } from "./ollama-client.ts";
import db from "./db-client.ts";
import type { IndividualVote } from "./types.ts";
import { canonicalizeBudgetIndicatorName } from "./budget-indicator.ts";

// ── ChunkLike: local mirror of chunker.ts Chunk (avoids heavy bundler dep) ───
// This must stay in sync with the Chunk interface in chunker.ts.
// Fields: text, token_count, page_number_start/end, bbox_start/end, overlap_prev/next

interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ChunkLike {
  text: string;
  token_count: number;
  page_number_start: number | null;
  page_number_end: number | null;
  bbox_start: BBox | null;
  bbox_end: BBox | null;
  overlap_prev: boolean;
  overlap_next: boolean;
}

// ── LLM temperature (see DEPS.md: task 2-4 = 0.1) ────────────────────────────
const EXTRACTION_TEMPERATURE = 0.1;

// ── System prompts ────────────────────────────────────────────────────────────

const VOTE_TALLY_SYSTEM =
  "You are a structured data extractor for Fairfax County Board of Supervisors meeting records. " +
  "Your sole job is to identify and extract vote tallies. " +
  "Respond with ONLY valid JSON — no markdown fences, no explanation, no preamble.";

const POLICY_DECISION_SYSTEM =
  "You are a structured data extractor for Fairfax County Board of Supervisors fiscal policy " +
  "actions (tax rates, fees, appropriations, budget adoptions, bonds, grants). " +
  "Respond with ONLY valid JSON — no markdown fences, no explanation, no preamble.";

const BUDGET_INDICATOR_SYSTEM =
  "You are a structured data extractor for Fairfax County budget performance indicators. " +
  "Extract all measurable metrics, targets, and year-over-year comparisons. " +
  "Respond with ONLY valid JSON — no markdown fences, no explanation, no preamble.";

// ── User prompts ──────────────────────────────────────────────────────────────

function voteTallyUserPrompt(text: string): string {
  return (
    "Extract every vote tally from this Fairfax County Board of Supervisors meeting content.\n" +
    'If no vote is present, return {"found":false,"vote_tallies":[]}.\n\n' +
    "Required JSON schema (return this exact shape):\n" +
    "{\n" +
    '  "found": boolean,\n' +
    '  "vote_tallies": [\n' +
    "    {\n" +
    '      "meeting_date": "YYYY-MM-DD",\n' +
    '      "motion_text": "brief description of motion or item number",\n' +
    '      "motion_type": "ordinance|resolution|proclamation|approval|adoption|authorization|appointment|motion|other",\n' +
    '      "outcome": "passed|failed|tabled|withdrawn|deferred",\n' +
    '      "vote_yes": integer,\n' +
    '      "vote_no": integer,\n' +
    '      "vote_abstain": integer,\n' +
    '      "vote_absent": integer,\n' +
    '      "individual_votes": [\n' +
    '        {"supervisor_name": "Full Name", "district": "District name e.g. Dranesville, Hunter Mill, At-Large", "vote": "yes|no|abstain|absent"}\n' +
    "      ]\n" +
    "    }\n" +
    "  ]\n" +
    "}\n\n" +
    "Content:\n" +
    text
  );
}

function policyDecisionUserPrompt(text: string): string {
  return (
    "Extract any fiscal policy decisions from this Fairfax County Board of Supervisors meeting content.\n" +
    'If no policy decision is present, return {"found":false,"policy_decisions":[]}.\n\n' +
    "Required JSON schema (return this exact shape):\n" +
    "{\n" +
    '  "found": boolean,\n' +
    '  "policy_decisions": [\n' +
    "    {\n" +
    '      "meeting_date": "YYYY-MM-DD",\n' +
    '      "decision_type": "tax_rate|fee_schedule|appropriation|budget_adoption|bond_authorization|grant_acceptance|other",\n' +
    '      "subject": "concise description of what was decided",\n' +
    '      "fiscal_year": integer_or_null,\n' +
    '      "amount_dollars": number_or_null,\n' +
    '      "rate_value": number_or_null,\n' +
    '      "rate_unit": "string_or_null e.g. percent per dollar",\n' +
    '      "effective_date": "YYYY-MM-DD_or_null",\n' +
    '      "is_amendment": boolean\n' +
    "    }\n" +
    "  ]\n" +
    "}\n\n" +
    "Content:\n" +
    text
  );
}

function budgetIndicatorUserPrompt(text: string): string {
  return (
    "Extract every quantifiable performance indicator from this budget document content.\n" +
    "Include actuals, targets, and prior-year comparisons.\n" +
    'If no measurable indicator is present, return {"found":false,"indicators":[]}.\n\n' +
    "Required JSON schema (return this exact shape):\n" +
    "{\n" +
    '  "found": boolean,\n' +
    '  "indicators": [\n' +
    "    {\n" +
    '      "fiscal_year": integer,\n' +
    '      "department": "string_or_null",\n' +
    '      "program": "string_or_null",\n' +
    '      "indicator_name": "exact metric name as written",\n' +
    '      "value_actual": number_or_null,\n' +
    '      "value_target": number_or_null,\n' +
    '      "value_prior_year": number_or_null,\n' +
    '      "unit": "string_or_null e.g. calls percent dollars hours cases"\n' +
    "    }\n" +
    "  ]\n" +
    "}\n\n" +
    "Content:\n" +
    text
  );
}

// ── JSON parse helper ─────────────────────────────────────────────────────────

function safeParseJson<T>(raw: string): T | null {
  try {
    // Strip markdown code fences if the LLM added them
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// ── Per-chunk extractors ──────────────────────────────────────────────────────

interface VoteTallyLlm {
  meeting_date: string;
  motion_text: string;
  motion_type: string;
  outcome: string;
  vote_yes?: number;
  vote_no?: number;
  vote_abstain?: number;
  vote_absent?: number;
  individual_votes?: Array<
    { supervisor_name: string; district: string; vote: string }
  >;
}

async function tryExtractVoteTallies(
  documentId: string,
  chunk: ChunkLike,
  chunkSequence: number,
): Promise<string[]> {
  const result = await ollamaChat(
    [
      { role: "system", content: VOTE_TALLY_SYSTEM },
      { role: "user", content: voteTallyUserPrompt(chunk.text) },
    ],
    EXTRACTION_TEMPERATURE,
  );

  if (result.exhausted) {
    console.warn(
      `[extractor] VoteTally LLM exhausted on chunk ${chunkSequence}`,
    );
    return [];
  }

  const parsed = safeParseJson<
    { found: boolean; vote_tallies?: VoteTallyLlm[] }
  >(
    result.content,
  );
  if (!parsed?.found || !parsed.vote_tallies?.length) return [];

  const rows = parsed.vote_tallies.map((vt) => ({
    id: uuidv7(),
    document_id: documentId,
    chunk_sequence: chunkSequence,
    meeting_date: vt.meeting_date,
    motion_text: vt.motion_text ?? "",
    motion_type: vt.motion_type ?? "other",
    outcome: vt.outcome ?? "passed",
    vote_yes: vt.vote_yes ?? 0,
    vote_no: vt.vote_no ?? 0,
    vote_abstain: vt.vote_abstain ?? 0,
    vote_absent: vt.vote_absent ?? 0,
    individual_votes: (vt.individual_votes ?? []) as IndividualVote[],
    page_number_start: chunk.page_number_start,
    page_number_end: chunk.page_number_end,
    bbox_start: chunk.bbox_start,
    bbox_end: chunk.bbox_end,
  }));

  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db.from("vote_tallies").insert(rows).select("id") as any);

  if (error) {
    console.error(
      `[extractor] vote_tallies insert error on chunk ${chunkSequence}: ${error.message}`,
    );
    return [];
  }
  // deno-lint-ignore no-explicit-any
  return ((data ?? []) as any[]).map((r: { id: string }) => r.id);
}

interface PolicyDecisionLlm {
  meeting_date: string;
  decision_type: string;
  subject: string;
  fiscal_year?: number | null;
  amount_dollars?: number | null;
  rate_value?: number | null;
  rate_unit?: string | null;
  effective_date?: string | null;
  is_amendment?: boolean;
}

async function tryExtractPolicyDecisions(
  documentId: string,
  chunk: ChunkLike,
  chunkSequence: number,
  voteTallyId: string | null,
): Promise<boolean> {
  const result = await ollamaChat(
    [
      { role: "system", content: POLICY_DECISION_SYSTEM },
      { role: "user", content: policyDecisionUserPrompt(chunk.text) },
    ],
    EXTRACTION_TEMPERATURE,
  );

  if (result.exhausted) {
    console.warn(
      `[extractor] PolicyDecision LLM exhausted on chunk ${chunkSequence}`,
    );
    return false;
  }

  const parsed = safeParseJson<
    { found: boolean; policy_decisions?: PolicyDecisionLlm[] }
  >(
    result.content,
  );
  if (!parsed?.found || !parsed.policy_decisions?.length) return false;

  const rows = parsed.policy_decisions.map((pd) => ({
    id: uuidv7(),
    document_id: documentId,
    chunk_sequence: chunkSequence,
    vote_tally_id: voteTallyId,
    meeting_date: pd.meeting_date,
    decision_type: pd.decision_type ?? "other",
    subject: pd.subject ?? "",
    fiscal_year: pd.fiscal_year ?? null,
    amount_dollars: pd.amount_dollars ?? null,
    rate_value: pd.rate_value ?? null,
    rate_unit: pd.rate_unit ?? null,
    effective_date: pd.effective_date ?? null,
    is_amendment: pd.is_amendment ?? false,
    raw_extracted_text: chunk.text,
    page_number_start: chunk.page_number_start,
    page_number_end: chunk.page_number_end,
    bbox_start: chunk.bbox_start,
    bbox_end: chunk.bbox_end,
  }));

  const { error } = await db.from("policy_decisions").insert(rows);
  if (error) {
    console.error(
      `[extractor] policy_decisions insert error on chunk ${chunkSequence}: ${error.message}`,
    );
    return false;
  }
  return true;
}

interface BudgetIndicatorLlm {
  fiscal_year: number;
  department?: string | null;
  program?: string | null;
  indicator_name: string;
  value_actual?: number | null;
  value_target?: number | null;
  value_prior_year?: number | null;
  unit?: string | null;
}

async function tryExtractBudgetIndicators(
  documentId: string,
  chunk: ChunkLike,
  chunkSequence: number,
): Promise<boolean> {
  const result = await ollamaChat(
    [
      { role: "system", content: BUDGET_INDICATOR_SYSTEM },
      { role: "user", content: budgetIndicatorUserPrompt(chunk.text) },
    ],
    EXTRACTION_TEMPERATURE,
  );

  if (result.exhausted) {
    console.warn(
      `[extractor] BudgetIndicator LLM exhausted on chunk ${chunkSequence}`,
    );
    return false;
  }

  const parsed = safeParseJson<
    { found: boolean; indicators?: BudgetIndicatorLlm[] }
  >(
    result.content,
  );
  if (!parsed?.found || !parsed.indicators?.length) return false;

  const rows = parsed.indicators.map((ind) => ({
    id: uuidv7(),
    document_id: documentId,
    chunk_sequence: chunkSequence,
    fiscal_year: ind.fiscal_year,
    department: ind.department ?? null,
    program: ind.program ?? null,
    indicator_name: canonicalizeBudgetIndicatorName(ind.indicator_name ?? ""),
    value_actual: ind.value_actual ?? null,
    value_target: ind.value_target ?? null,
    value_prior_year: ind.value_prior_year ?? null,
    unit: ind.unit ?? null,
    raw_extracted_text: chunk.text,
    page_number_start: chunk.page_number_start,
    page_number_end: chunk.page_number_end,
    bbox_start: chunk.bbox_start,
    bbox_end: chunk.bbox_end,
  }));

  const { error } = await db.from("budget_indicators").insert(rows);
  if (error) {
    console.error(
      `[extractor] budget_indicators insert error on chunk ${chunkSequence}: ${error.message}`,
    );
    return false;
  }
  return true;
}

async function writeNarrativeChunk(
  documentId: string,
  chunk: ChunkLike,
  chunkSequence: number,
): Promise<void> {
  const { error } = await db.from("narrative_chunks").insert({
    id: uuidv7(),
    document_id: documentId,
    chunk_sequence: chunkSequence,
    content: chunk.text,
    token_count: chunk.token_count,
    overlap_prev: chunk.overlap_prev,
    overlap_next: chunk.overlap_next,
    page_number_start: chunk.page_number_start,
    page_number_end: chunk.page_number_end,
    bbox_start: chunk.bbox_start,
    bbox_end: chunk.bbox_end,
  });
  if (error) {
    console.error(
      `[extractor] narrative_chunks insert error on chunk ${chunkSequence}: ${error.message}`,
    );
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

const DEADLINE_BUFFER_MS = 20_000; // 20 s buffer before hard kill

/**
 * Run LLM extraction on all chunks and persist to the appropriate tables.
 * Any chunk without structured extraction falls back to narrative_chunks.
 * Does NOT touch documents.status — finalization is owned by task 2-6.
 *
 * Called from ingest-orchestrator immediately after document_chunks are
 * persisted (task 2-3 to 2-4 handoff).
 *
 * @param documentId  UUID of the Document shell row (created in task 2-1)
 * @param docType     doc_type string from documents table
 * @param chunks      Ordered ChunkLike array from chunkBlocks() (task 2-3)
 * @param deadlineMs  Optional Date.now() value of the soft cutoff; when
 *                    within DEADLINE_BUFFER_MS of this value, remaining
 *                    chunks are bulk-inserted as narrative_chunks and the
 *                    loop exits early so embedNarrativeChunks can finish.
 */
export async function extractAndPersist(
  documentId: string,
  docType: string,
  chunks: ChunkLike[],
  deadlineMs?: number,
): Promise<void> {
  const isBosType = docType === "bos_minutes" || docType === "bos_summary";
  const isBudgetType = docType === "budget_pdf";

  let structuredCount = 0;
  let narrativeCount = 0;

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    // chunk_sequence is 1-based; idx is 0-based
    const chunkSequence = idx + 1;

    // Soft deadline: bulk-insert all remaining chunks as narrative_chunks so
    // the pipeline can still embed and finalize within the wall-clock limit.
    if (
      deadlineMs !== undefined && Date.now() >= deadlineMs - DEADLINE_BUFFER_MS
    ) {
      const remainingChunks = chunks.slice(idx);
      if (remainingChunks.length > 0) {
        const rows = remainingChunks.map((c, offset) => ({
          id: uuidv7(),
          document_id: documentId,
          chunk_sequence: chunkSequence + offset,
          content: c.text,
          token_count: c.token_count,
          overlap_prev: c.overlap_prev,
          overlap_next: c.overlap_next,
          page_number_start: c.page_number_start,
          page_number_end: c.page_number_end,
          bbox_start: c.bbox_start,
          bbox_end: c.bbox_end,
        }));
        const { error: deadlineErr } = await db.from("narrative_chunks").insert(
          rows,
        );
        if (deadlineErr) {
          throw new Error(
            `deadline bulk-insert narrative_chunks: ${deadlineErr.message}`,
          );
        }
        console.warn(
          `[extractor] soft deadline hit at chunk ${chunkSequence}/${chunks.length}; inserted ${remainingChunks.length} remaining as narrative_chunks`,
        );
        narrativeCount += remainingChunks.length;
      }
      break;
    }

    let hasStructured = false;

    try {
      if (isBosType) {
        // BOS minutes / summary: VoteTally + PolicyDecision
        const tallyIds = await tryExtractVoteTallies(
          documentId,
          chunk,
          chunkSequence,
        );
        if (tallyIds.length > 0) hasStructured = true;

        const linkedTallyId = tallyIds.length > 0 ? tallyIds[0] : null;
        const gotDecision = await tryExtractPolicyDecisions(
          documentId,
          chunk,
          chunkSequence,
          linkedTallyId,
        );
        if (gotDecision) hasStructured = true;
      } else if (isBudgetType) {
        // Budget PDF: BudgetIndicator
        const gotIndicator = await tryExtractBudgetIndicators(
          documentId,
          chunk,
          chunkSequence,
        );
        if (gotIndicator) hasStructured = true;
      }
      // Other doc types: fall through to narrative_chunks
    } catch (e) {
      // Extraction errors must not abort the pipeline
      console.error(
        `[extractor] unexpected error on chunk ${chunkSequence}: ${(e as Error).message}`,
      );
    }

    if (!hasStructured) {
      await writeNarrativeChunk(documentId, chunk, chunkSequence);
      narrativeCount++;
    } else {
      structuredCount++;
    }
  }

  console.log(
    `[extractor] done — ${structuredCount} structured, ${narrativeCount} narrative for doc ${documentId}`,
  );
}
