/**
 * Pure helper functions for the amendment-resolution Edge Function.
 * Extracted here so they can be unit-tested without the Deno.serve() side-effect
 * or a live DB/Ollama connection — same split as reconciliation/_helpers.ts.
 */

import type { OllamaMessage } from "../_shared/ollama-client.ts";

export interface PolicyDecisionForResolution {
  id: string;
  document_id: string;
  vote_tally_id: string | null;
  meeting_date: string;
  decision_type: string;
  subject: string;
  effective_date: string | null;
  raw_extracted_text: string;
}

export interface OrdinanceCandidate {
  id: string;
  municode_node_id: string;
  section_title: string | null;
  content: string;
}

// ── Citation extraction ───────────────────────────────────────────────────────

const CHAPTER_RE = /chapter\s+(\d+(?:\.\d+)?)/gi;
const APPENDIX_RE = /appendix\s+([ivxlc]+)\b/gi;

/**
 * Extracts normalized Municode chapter/appendix citation tokens from free text
 * (e.g. "Chapter 67.1" -> "CH67.1", "Appendix I" -> "APXI"). Tokens are matched
 * against municode_node_id as substrings -- Municode's own ID scheme embeds
 * these same abbreviated tokens (e.g. "FACOCO_CH67.1SASESEDI...",
 * "THCOCOFAVI1976_APXIFACOSPSEDI...").
 */
export function extractCitationTokens(text: string): string[] {
  const tokens = new Set<string>();

  for (const match of text.matchAll(CHAPTER_RE)) {
    tokens.add(`CH${match[1].toUpperCase()}`);
  }
  for (const match of text.matchAll(APPENDIX_RE)) {
    tokens.add(`APX${match[1].toUpperCase()}`);
  }

  return [...tokens];
}

/** True when nodeId contains at least one of the given citation tokens. */
export function matchesCitation(nodeId: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const upper = nodeId.toUpperCase();
  return tokens.some((t) => upper.includes(t));
}

// ── Keyword extraction ────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the",
  "of",
  "and",
  "to",
  "for",
  "in",
  "on",
  "a",
  "an",
  "is",
  "are",
  "be",
  "by",
  "as",
  "or",
  "that",
  "this",
  "with",
  "from",
  "at",
  "approval",
  "adoption",
  "amendment",
  "amendments",
  "proposed",
  "board",
  "decision",
  "decisions",
  "supervisors",
  "fiscal",
  "fairfax",
  "county",
  "code",
  "authorization",
  "approve",
  "approving",
  "resolution",
  "regarding",
  "review",
  "third",
  "quarter",
  "annual",
  "fy",
  "year",
]);

/**
 * Extracts distinctive keywords from a policy decision's subject line for use
 * as BM25/title search anchors. Strips punctuation, lowercases, drops
 * stopwords and short tokens, dedupes, and orders longest-first (longer words
 * tend to be more distinctive search anchors than short common ones).
 */
export function extractKeywords(subject: string, max = 6): string[] {
  const words = subject
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
    }
  }

  return unique.sort((a, b) => b.length - a.length).slice(0, max);
}

// ── Candidate ranking ──────────────────────────────────────────────────────────

/**
 * If any candidate's node_id matches an extracted citation token, narrow the
 * pool to just those (a citation is a much stronger signal than keyword
 * overlap). Otherwise return the deduped candidate list, capped.
 */
export function rankAndCapCandidates(
  candidates: OrdinanceCandidate[],
  citationTokens: string[],
  cap = 8,
): OrdinanceCandidate[] {
  const deduped = new Map<string, OrdinanceCandidate>();
  for (const c of candidates) deduped.set(c.id, c);
  const list = [...deduped.values()];

  if (citationTokens.length > 0) {
    const citationMatches = list.filter((c) =>
      matchesCitation(c.municode_node_id, citationTokens)
    );
    if (citationMatches.length > 0) return citationMatches.slice(0, cap);
  }

  return list.slice(0, cap);
}

// ── LLM resolution ─────────────────────────────────────────────────────────────

export interface ResolutionLlmResult {
  matched: boolean;
  municode_node_id: string | null;
  confidence: "high" | "medium" | "low";
  notes: string;
}

const VALID_CONFIDENCE = ["high", "medium", "low"];

function contentSnippet(content: string, max = 600): string {
  return content.length > max ? `${content.slice(0, max)}…` : content;
}

export function buildResolutionMessages(
  decision: PolicyDecisionForResolution,
  candidates: OrdinanceCandidate[],
): OllamaMessage[] {
  const candidateList = candidates
    .map((c, i) =>
      `${i + 1}. municode_node_id: "${c.municode_node_id}"\n   section_title: ${
        c.section_title ?? "(none)"
      }\n   content: ${contentSnippet(c.content)}`
    )
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        `You are a legal-text resolution assistant for Fairfax County, Virginia. Given a Board of ` +
        `Supervisors fiscal/policy decision and a shortlist of currently codified ordinance provisions, ` +
        `decide whether the decision is clearly amending exactly ONE of the listed provisions.\n\n` +
        `Return ONLY a JSON object with exactly four fields:\n` +
        `- "matched": boolean -- true only if you are confident the decision amends one specific listed provision\n` +
        `- "municode_node_id": the municode_node_id string of the matched provision, or null if not matched\n` +
        `- "confidence": one of "high", "medium", "low"\n` +
        `- "notes": a brief explanation (1-3 sentences)\n\n` +
        `Rules:\n` +
        `- Only ever return a municode_node_id that appears verbatim in the candidate list below.\n` +
        `- If the decision could plausibly relate to more than one candidate, or the connection is topical ` +
        `but not a clear textual amendment, set matched=false and confidence to "low" or "medium".\n` +
        `- If none of the candidates are a good fit, set matched=false, municode_node_id=null.\n` +
        `- Never guess. It is always safer to return matched=false than to fabricate a match.\n\n` +
        `Respond ONLY with valid JSON. No preamble, no text outside the JSON object.`,
    },
    {
      role: "user",
      content: `**Board Decision:**
Type: ${decision.decision_type}
Subject: ${decision.subject}
Meeting date: ${decision.meeting_date}
Source text: ${contentSnippet(decision.raw_extracted_text, 1000)}

**Candidate Currently Codified Provisions:**
${candidateList}`,
    },
  ];
}

/**
 * Parses the LLM's resolution JSON, then validates municode_node_id against
 * the real candidate set -- a fabricated or mistyped node_id (one the LLM
 * didn't copy verbatim from the candidate list) is always downgraded to
 * matched=false rather than trusted, regardless of what the model claimed.
 */
export function parseResolutionLlmResult(
  content: string,
  validNodeIds: Set<string>,
): ResolutionLlmResult {
  const jsonMatch = content.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    return {
      matched: false,
      municode_node_id: null,
      confidence: "low",
      notes: "LLM response could not be parsed as JSON",
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return {
      matched: false,
      municode_node_id: null,
      confidence: "low",
      notes: "LLM response JSON parse failed",
    };
  }

  const confidence: ResolutionLlmResult["confidence"] =
    VALID_CONFIDENCE.includes(
        parsed.confidence as string,
      )
      ? (parsed.confidence as ResolutionLlmResult["confidence"])
      : "low";
  const notes = typeof parsed.notes === "string" ? parsed.notes : "";
  const claimedNodeId = typeof parsed.municode_node_id === "string"
    ? parsed.municode_node_id
    : null;
  const matchedClaim = parsed.matched === true;

  if (!matchedClaim || !claimedNodeId || !validNodeIds.has(claimedNodeId)) {
    return {
      matched: false,
      municode_node_id: null,
      confidence,
      notes: claimedNodeId && !validNodeIds.has(claimedNodeId)
        ? `LLM returned a node_id not in the candidate list (${claimedNodeId}); rejected. ${notes}`
          .trim()
        : notes,
    };
  }

  return { matched: true, municode_node_id: claimedNodeId, confidence, notes };
}

/** Only ever accept a high-confidence, verified match -- everything else stays unresolved. */
export function shouldAcceptResolution(result: ResolutionLlmResult): boolean {
  return result.matched && result.confidence === "high" &&
    result.municode_node_id !== null;
}

// ── Row builders ───────────────────────────────────────────────────────────────

export interface AmendmentEventInsert {
  id: string;
  municode_node_id: string;
  ordinance_number: null;
  resolution_number: null;
  adopted_date: string;
  effective_date: string;
  effective_date_source: "default" | "bos_summary";
  amendment_text: string;
  vote_tally_id: string;
  document_id: string;
}

export interface PendingCodeChangeInsert {
  id: string;
  municode_node_id: string;
  proposed_text: string;
  on_spot_edits: null;
  codification_status: "pending";
  effective_date: string;
  effective_date_source: "default" | "bos_summary";
  amendment_event_id: string;
  document_id: string;
  codified_at: null;
}

export function resolveEffectiveDate(
  decision: Pick<
    PolicyDecisionForResolution,
    "effective_date" | "meeting_date"
  >,
): {
  effective_date: string;
  effective_date_source: "default" | "bos_summary";
} {
  return decision.effective_date
    ? {
      effective_date: decision.effective_date,
      effective_date_source: "bos_summary",
    }
    : {
      effective_date: decision.meeting_date,
      effective_date_source: "default",
    };
}

export function buildAmendmentEventRow(
  decision: PolicyDecisionForResolution,
  resolvedNodeId: string,
  newId: string,
): AmendmentEventInsert {
  const { effective_date, effective_date_source } = resolveEffectiveDate(
    decision,
  );
  if (decision.vote_tally_id === null) {
    throw new Error("buildAmendmentEventRow requires a non-null vote_tally_id");
  }

  return {
    id: newId,
    municode_node_id: resolvedNodeId,
    ordinance_number: null,
    resolution_number: null,
    adopted_date: decision.meeting_date,
    effective_date,
    effective_date_source,
    amendment_text: decision.raw_extracted_text,
    vote_tally_id: decision.vote_tally_id,
    document_id: decision.document_id,
  };
}

export function buildPendingCodeChangeRow(
  decision: PolicyDecisionForResolution,
  resolvedNodeId: string,
  amendmentEventId: string,
  newId: string,
): PendingCodeChangeInsert {
  const { effective_date, effective_date_source } = resolveEffectiveDate(
    decision,
  );

  return {
    id: newId,
    municode_node_id: resolvedNodeId,
    proposed_text: decision.raw_extracted_text,
    on_spot_edits: null,
    codification_status: "pending",
    effective_date,
    effective_date_source,
    amendment_event_id: amendmentEventId,
    document_id: decision.document_id,
    codified_at: null,
  };
}
