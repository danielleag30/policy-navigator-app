/**
 * Deep-historical live lookup — the query-pipeline "slow path" (parked item,
 * policy-navigator-06-execution-log.md, 2026-07-17 "deep-historical" /
 * "slow-path" entry).
 *
 * WHY THIS EXISTS: the normal pipeline (index.ts) is deliberately fail-loud —
 * when pre-ingested retrieval finds nothing, it returns incompleteSearchWarning
 * rather than silently falling back or fabricating (AC 7). That standard does
 * not change here. But some genuinely rare queries ask about a specific
 * historical era that was never worth pre-ingesting (e.g. "what did the
 * zoning ordinance say about home occupations in 1948?") — 80 years of
 * scanned zoning-ordinance archive is low-value to index wholesale, but
 * Danielle confirmed it's acceptable for the app to take longer on the rare
 * query that actually needs it, via an extended-timeout, explicitly-disclosed
 * live fetch against a real source instead of either pre-ingesting everything
 * or refusing outright.
 *
 * SOURCE: EnCode Archives' full historical Zoning Ordinance reprints
 * (https://online.encodeplus.com/regs/fairfaxcounty-va/archivedialog.aspx) —
 * 18 real full-ordinance-text PDF reprints spanning 1941-2021, confirmed live
 * against the site 2026-07-21 (the "Historical Amendment Index" entry on that
 * same page is excluded here: it's a dated summary/index, not full section
 * text, same distinction encode.ts already draws for the *current* Amendment
 * History Table). Each reprint documents the ordinance as amended through its
 * label year and remains the accurate historical record until the next
 * reprint in the list (or, for the last one, until zMOD's real effective date
 * 2023-05-10 — see project_policy_navigator memory / PR #101 for why that
 * date and not a 2021 one). ENCODE_ZONING_REPRINTS below is therefore a
 * hardcoded lookup table, not a live-scraped index — mirrors encode.ts's own
 * documented convention of hardcoding stable-but-manually-verified EnCode ids
 * (ROOT_TOCID/ROOT_SECID/AMENDMENT_HISTORY_SECID) rather than re-parsing
 * archivedialog.aspx's HTML on every request. Re-verify against the live page
 * before trusting this table if EnCode's archive contents ever change.
 *
 * COMPLIANCE: doclibrary.aspx lives under the same /regs/fairfaxcounty-va/
 * path that EnCode's robots.txt disallows for generic crawlers (see
 * ingest-orchestrator/encode.ts's file-header COMPLIANCE NOTE) — this module
 * reuses that file's compliance gate (ENCODE_ZONING_ENABLED secret) and its
 * self-identifying ENCODE_BASE_URL/ENCODE_USER_AGENT env vars rather than a
 * separate flag, so a legal/human sign-off revocation shuts off both paths
 * together. No network request is made — not even the Docling call — unless
 * the gate is exactly "true". Edge Functions don't cross-import code between
 * sibling function directories (see DEPS.md / repo convention: shared code
 * lives in _shared/); the two default constants below are intentionally kept
 * in sync with encode.ts's DEFAULT_ENCODE_BASE_URL/DEFAULT_ENCODE_USER_AGENT
 * by hand rather than imported.
 *
 * NEVER-FABRICATE GUARANTEE: this path has exactly the same "cannot provide
 * incorrect data" standard as the rest of the app. A failed fetch, a Docling
 * error, zero lexically-relevant excerpt text, or an LLM response that isn't
 * a validated, page-cited answer all fall through to a refusal outcome
 * (status "not_found" or "failed") — never a guess. See runDeepHistoricalLookup.
 */

import { generate as uuidv7 } from "@std/uuid/v7";
import { type Chunk, chunkBlocks, type FlatBlock } from "../_shared/chunker.ts";
import { ollamaChat } from "../_shared/ollama-client.ts";

// ── Reprint table ─────────────────────────────────────────────────────────────

export interface DeepHistoricalReprint {
  /** e.g. "1945 Reprint" — matches the EnCode Archives page label exactly. */
  label: string;
  /** The year this reprint documents the ordinance as amended through. */
  year: number;
  /** doclibrary.aspx GUID, confirmed live against archivedialog.aspx 2026-07-21. */
  docLibraryId: string;
}

/** Ascending by year — selectReprintForYear relies on this ordering. */
export const ENCODE_ZONING_REPRINTS: DeepHistoricalReprint[] = [
  {
    label: "1941 Original",
    year: 1941,
    docLibraryId: "bdc0931d-1f17-49e6-b108-b540145fdfa4",
  },
  {
    label: "1945 Reprint",
    year: 1945,
    docLibraryId: "a5e9f7fb-e390-4860-8308-4e0316da937d",
  },
  {
    label: "1954 Reprint",
    year: 1954,
    docLibraryId: "9c2751a3-13a6-4b10-a8f3-444e008235c5",
  },
  {
    label: "1959 Original",
    year: 1959,
    docLibraryId: "d6061d67-a6b9-4da2-b183-fb17802483df",
  },
  {
    label: "1971 Reprint",
    year: 1971,
    docLibraryId: "9f032fd2-2caa-4320-b2d5-a804b07f7732",
  },
  {
    label: "1978 ZO",
    year: 1978,
    docLibraryId: "1c3cbaa1-4e61-45b0-a36c-f9dd164cd691",
  },
  {
    label: "1982 Reprint",
    year: 1982,
    docLibraryId: "c776eed3-b79d-4d91-a662-ff54053a2fed",
  },
  {
    label: "1985 Reprint",
    year: 1985,
    docLibraryId: "e440ac8d-95d0-4e5e-8397-2a18c6b12909",
  },
  {
    label: "1987 Reprint",
    year: 1987,
    docLibraryId: "1127585a-181b-442d-9ed4-bb14ef66cc60",
  },
  {
    label: "1988 Reprint",
    year: 1988,
    docLibraryId: "19a8f225-378a-4129-a5ba-54739e8b7f41",
  },
  {
    label: "1989 Reprint",
    year: 1989,
    docLibraryId: "8aa9169d-1a7f-4345-a3f7-5bc1b97f248b",
  },
  {
    label: "1990 Reprint",
    year: 1990,
    docLibraryId: "bd1f6f1e-d380-45df-8e96-8d457127ce2a",
  },
  {
    label: "1995 Reprint",
    year: 1995,
    docLibraryId: "1fac8691-e5d0-494a-a192-4462984f7cbe",
  },
  {
    label: "1997 Reprint",
    year: 1997,
    docLibraryId: "3188bed6-e657-4176-b5b2-530550c77088",
  },
  {
    label: "2002 Reprint",
    year: 2002,
    docLibraryId: "3704c9f8-311c-4d76-a5ca-d77a390aa76b",
  },
  {
    label: "2007 Reprint",
    year: 2007,
    docLibraryId: "d7ac248e-c2cc-47d2-8ce5-e66322974acb",
  },
  {
    label: "2012 Reprint",
    year: 2012,
    docLibraryId: "d453470c-aad1-4d6e-bf81-838b6f2d7a6c",
  },
  {
    label: "2017 Reprint",
    year: 2017,
    docLibraryId: "9bfb7ae6-4676-4047-b19b-9fa9e8eb210b",
  },
  {
    label: "2021 Reprint",
    year: 2021,
    docLibraryId: "922528cd-6de4-4112-8678-79e8ed26a092",
  },
];

const EARLIEST_REPRINT_YEAR = ENCODE_ZONING_REPRINTS[0].year; // 1941
/** zMOD's real effective date (2023-05-10, see project memory / PR #101) supersedes every reprint above. */
const CURRENT_ERA_BOUNDARY_YEAR = 2023;

// Mirrors ingest-orchestrator/encode.ts's DEFAULT_ENCODE_BASE_URL (same
// ENCODE_BASE_URL env var name — one secret update covers both paths). No
// user-agent constant is needed here: unlike encode.ts's own crawler, this
// module never issues the outbound HTTP request itself — the Docling wrapper
// (HF_SPACES_DOCLING_URL) fetches the target URL server-side on our behalf.
const DEFAULT_ENCODE_BASE_URL =
  "https://online.encodeplus.com/regs/fairfaxcounty-va";

export function reprintDocUrl(reprint: DeepHistoricalReprint): string {
  const baseUrl = Deno.env.get("ENCODE_BASE_URL") ?? DEFAULT_ENCODE_BASE_URL;
  return `${baseUrl}/doclibrary.aspx?id=${reprint.docLibraryId}`;
}

/**
 * Find the reprint whose coverage window includes `year`: the reprint with
 * the largest year <= the target year (a reprint documents the ordinance as
 * amended through its own year and stays accurate until superseded by the
 * next reprint in the list). Returns null if `year` predates every reprint
 * (EARLIEST_REPRINT_YEAR) — there's no source to attempt, so the caller must
 * not guess.
 */
export function selectReprintForYear(
  year: number,
): DeepHistoricalReprint | null {
  let selected: DeepHistoricalReprint | null = null;
  for (const reprint of ENCODE_ZONING_REPRINTS) {
    if (reprint.year <= year) {
      selected = reprint;
    } else {
      break;
    }
  }
  return selected;
}

// ── Trigger heuristic ────────────────────────────────────────────────────────

/**
 * Extract a candidate "deep historical" year from the query text: the first
 * 4-digit year found that falls strictly before CURRENT_ERA_BOUNDARY_YEAR
 * (the normal corpus already covers the current era) and at or after
 * EARLIEST_REPRINT_YEAR (nothing older has any available source). Returns
 * null for queries with no year, or a year outside that window — those
 * queries get the standard incompleteSearchWarning response, not the slow
 * path, because there is nothing this module could productively fetch.
 */
export function extractDeepHistoricalYear(query: string): number | null {
  const matches = query.match(/\b(19|20)\d{2}\b/g);
  if (!matches) return null;
  for (const raw of matches) {
    const year = parseInt(raw, 10);
    if (year >= EARLIEST_REPRINT_YEAR && year < CURRENT_ERA_BOUNDARY_YEAR) {
      return year;
    }
  }
  return null;
}

export type DeepHistoricalTrigger =
  | { attempt: true; year: number; reprint: DeepHistoricalReprint }
  | { attempt: false };

/**
 * Decide whether to attempt the slow path. Both conditions must hold:
 *  1. The fast pre-ingested-corpus retrieval genuinely found nothing
 *     (maxRrfScore below the same INCOMPLETE_SEARCH_FLOOR the normal path
 *     already gates on — this module never runs instead of a real corpus hit).
 *  2. The query text names a specific year within EnCode's reprint coverage.
 * Also requires the ENCODE_ZONING_ENABLED compliance gate — see file header.
 */
export function shouldAttemptDeepHistoricalLookup(
  query: string,
  maxRrfScore: number,
  incompleteSearchFloor: number,
): DeepHistoricalTrigger {
  if (maxRrfScore >= incompleteSearchFloor) return { attempt: false };
  if (Deno.env.get("ENCODE_ZONING_ENABLED") !== "true") {
    return { attempt: false };
  }

  const year = extractDeepHistoricalYear(query);
  if (year === null) return { attempt: false };

  const reprint = selectReprintForYear(year);
  if (reprint === null) return { attempt: false };

  return { attempt: true, year, reprint };
}

// ── Lexical relevance scoring (in-memory only — this document was never ingested) ──

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "for",
  "to",
  "and",
  "or",
  "is",
  "was",
  "were",
  "are",
  "what",
  "when",
  "where",
  "how",
  "did",
  "does",
  "do",
  "which",
  "that",
  "this",
  "it",
  "as",
  "by",
  "with",
  "from",
  "at",
  "be",
  "been",
  "being",
  "county",
  "fairfax",
  "ordinance",
  "zoning",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractQueryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(words)].filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function scoreChunkText(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const re = new RegExp(`\\b${escapeRegExp(term)}`, "g");
    const matches = lower.match(re);
    if (matches) score += matches.length;
  }
  return score;
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

/**
 * Rank chunks by lexical overlap with the query and return the top `limit`
 * with score > 0. This is the whole-document analog of the normal pipeline's
 * BM25 leg — there is no DB index to query since this text was fetched live,
 * so relevance is scored directly against the freshly extracted chunks.
 */
export function selectRelevantChunks(
  chunks: Chunk[],
  query: string,
  limit: number,
): Chunk[] {
  const terms = extractQueryTerms(query);
  if (terms.length === 0) return [];

  const scored: ScoredChunk[] = chunks.map((chunk) => ({
    chunk,
    score: scoreChunkText(chunk.text, terms),
  }));

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.chunk);
}

// ── LLM drafting over the freshly fetched excerpt ───────────────────────────

const DEEP_HISTORICAL_CONTEXT_CHUNKS = 6;
// Prose may vary slightly while staying grounded — same rationale/value as the
// normal Answer Drafter (task 2-11, DEPS.md), documented separately here since
// this is a distinct call site with its own (extended) timeout.
const DEEP_HISTORICAL_DRAFTER_TEMPERATURE = 0.3;

function serializeChunkForPrompt(chunk: Chunk, index: number): string {
  const page = chunk.page_number_start ?? chunk.page_number_end ?? null;
  return `[excerpt ${index + 1}] page=${
    page === null ? "unknown" : page
  }\n${chunk.text}`;
}

function extractJson(raw: string): unknown | null {
  const stripped = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

interface DeepHistoricalDraft {
  answer: string;
  citedPages: number[];
}

/**
 * Validate the LLM's JSON output against the pages actually provided. A
 * refusal ("not in the documents") always validates. A non-refusal answer
 * MUST cite at least one page that was really in the provided excerpts —
 * anything else (missing citation, a page we never sent) is treated as
 * invalid so the caller falls back to a refusal rather than trusting an
 * uncited claim.
 */
function validateDeepHistoricalDraft(
  raw: unknown,
  availablePages: Set<number>,
): DeepHistoricalDraft | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.answer !== "string" || obj.answer.trim() === "") return null;

  const answer = obj.answer.trim();
  const isRefusal = answer.toLowerCase().includes("not in the documents");
  if (isRefusal) return { answer: "not in the documents", citedPages: [] };

  if (!Array.isArray(obj.cited_pages)) return null;
  const citedPages = (obj.cited_pages as unknown[])
    .filter((p): p is number => typeof p === "number");
  if (citedPages.length === 0) return null;
  if (!citedPages.every((p) => availablePages.has(p))) return null;

  return { answer, citedPages };
}

function buildSystemPrompt(reprint: DeepHistoricalReprint): string {
  return `You are the Deep Historical Answer Drafter for a municipal policy Q&A system (Fairfax County, Virginia).

The user's question could not be answered from the system's normal pre-indexed corpus, so real excerpt text was just fetched live from an official historical source: the "${reprint.label}" of the Fairfax County Zoning Ordinance (EnCode Archives), which documents the ordinance as amended through ${reprint.year}.

Use ONLY the provided excerpt text below. Do not use outside knowledge, and do not infer or guess at rules from other eras or other reprints.

Required behavior:
1. If the excerpts do not contain information that answers the question, respond with exactly: "not in the documents".
2. Otherwise, answer concisely and directly.
3. Every answer must be traceable to specific excerpt page(s); list every page number your answer draws from.
4. Output only valid JSON. No markdown fence and no prose outside JSON.

JSON schema:
{
  "answer": "<answer text, or exactly \\"not in the documents\\">",
  "cited_pages": [<page numbers your answer draws from, or [] if refusing>]
}`;
}

function buildUserPrompt(
  userQuery: string,
  reprint: DeepHistoricalReprint,
  chunks: Chunk[],
): string {
  const excerptBlock = chunks
    .map((c, i) => serializeChunkForPrompt(c, i))
    .join("\n\n---\n\n");

  return `User query:
${userQuery}

Source: Fairfax County Zoning Ordinance, "${reprint.label}" (documents the ordinance as amended through ${reprint.year}).

Excerpts (${chunks.length} highest lexical-relevance sections from the live-fetched document, highest first):
${excerptBlock}

Output JSON only:`;
}

// ── Docling fetch ────────────────────────────────────────────────────────────

interface DoclingResponse {
  blocks: FlatBlock[];
  block_count: number;
  docling_version: string;
}

async function fetchReprintBlocks(
  sourceUrl: string,
  timeoutMs: number,
): Promise<FlatBlock[]> {
  const doclingUrl = Deno.env.get("HF_SPACES_DOCLING_URL");
  if (!doclingUrl) {
    throw new Error("HF_SPACES_DOCLING_URL not set");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${doclingUrl.replace(/\/$/, "")}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: sourceUrl }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Docling wrapper returned HTTP ${resp.status}`);
    }
    const payload = await resp.json() as DoclingResponse;
    return payload.blocks ?? [];
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(
        `Docling call timed out after ${Math.ceil(timeoutMs / 1000)}s`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────

export type DeepHistoricalOutcome =
  | {
    status: "answered";
    answer: string;
    citationId: string;
    sourceUrl: string;
    sourceLabel: string;
    page: number | null;
    excerptText: string;
    fetchedAt: string;
  }
  | {
    status: "not_found";
    sourceUrl: string;
    sourceLabel: string;
    fetchedAt: string;
  }
  | {
    status: "failed";
    sourceUrl: string;
    sourceLabel: string;
    fetchedAt: string;
    reason: string;
  };

// 100s, matching ingest-orchestrator's own DOCLING_TIMEOUT_MS -- live-tested
// 2026-07-21 against the real HF Space: a cold instance took >45s but
// succeeded within 120s fetching the real "1945 Reprint" PDF, so this reuses
// the codebase's already-proven value rather than a lower guess.
const DEFAULT_DOCLING_TIMEOUT_MS = 100_000;
const DEFAULT_LLM_TIMEOUT_MS = 20_000;

/**
 * Run the full slow path: fetch the selected reprint PDF via the existing
 * Docling wrapper, chunk it, lexically rank chunks against the query, and
 * draft a page-cited answer. Every non-"answered" exit is a refusal, never a
 * guess (see file header NEVER-FABRICATE GUARANTEE). Extended timeouts here
 * (default 100s Docling + up to 20s per Ollama attempt, independently
 * retried up to 3x by ollamaChat) intentionally exceed the normal path's 15s
 * OLLAMA_TIMEOUT_MS ceiling — see DEPS.md for the documented worst-case
 * budget. Only this call site passes a timeoutMsOverride to ollamaChat; the
 * normal path's calls are untouched.
 */
export async function runDeepHistoricalLookup(
  userQuery: string,
  reprint: DeepHistoricalReprint,
): Promise<DeepHistoricalOutcome> {
  const sourceUrl = reprintDocUrl(reprint);
  const sourceLabel =
    `Fairfax County Zoning Ordinance — ${reprint.label} (EnCode Archives, live historical lookup)`;
  const fetchedAt = new Date().toISOString();

  const doclingTimeoutMs = parseInt(
    Deno.env.get("DEEP_HISTORICAL_DOCLING_TIMEOUT_MS") ??
      String(DEFAULT_DOCLING_TIMEOUT_MS),
    10,
  );
  const llmTimeoutMs = parseInt(
    Deno.env.get("DEEP_HISTORICAL_LLM_TIMEOUT_MS") ??
      String(DEFAULT_LLM_TIMEOUT_MS),
    10,
  );

  let blocks: FlatBlock[];
  try {
    blocks = await fetchReprintBlocks(sourceUrl, doclingTimeoutMs);
  } catch (e) {
    console.error(
      `[deep-historical] Docling fetch failed: ${(e as Error).message}`,
    );
    return {
      status: "failed",
      sourceUrl,
      sourceLabel,
      fetchedAt,
      reason: (e as Error).message,
    };
  }

  if (blocks.length === 0) {
    return { status: "not_found", sourceUrl, sourceLabel, fetchedAt };
  }

  const chunks = await chunkBlocks(blocks, 512, 0.15);
  const relevant = selectRelevantChunks(
    chunks,
    userQuery,
    DEEP_HISTORICAL_CONTEXT_CHUNKS,
  );
  if (relevant.length === 0) {
    console.log(
      "[deep-historical] no lexically relevant excerpts found in fetched reprint",
    );
    return { status: "not_found", sourceUrl, sourceLabel, fetchedAt };
  }

  const { content, exhausted } = await ollamaChat(
    [
      { role: "system", content: buildSystemPrompt(reprint) },
      { role: "user", content: buildUserPrompt(userQuery, reprint, relevant) },
    ],
    DEEP_HISTORICAL_DRAFTER_TEMPERATURE,
    llmTimeoutMs,
  );

  if (exhausted) {
    console.error("[deep-historical] Ollama exhausted after all retries");
    return {
      status: "failed",
      sourceUrl,
      sourceLabel,
      fetchedAt,
      reason: "OLLAMA_EXHAUSTED",
    };
  }

  const parsed = extractJson(content);
  if (parsed === null) {
    console.error(
      "[deep-historical] JSON extraction failed; raw response:",
      content.slice(0, 400),
    );
    return {
      status: "failed",
      sourceUrl,
      sourceLabel,
      fetchedAt,
      reason: "invalid LLM output",
    };
  }

  const availablePages = new Set(
    relevant
      .map((c) => c.page_number_start ?? c.page_number_end)
      .filter((p): p is number => p !== null),
  );
  const draft = validateDeepHistoricalDraft(parsed, availablePages);
  if (draft === null) {
    console.error(
      "[deep-historical] schema validation failed; parsed:",
      JSON.stringify(parsed).slice(0, 400),
    );
    return {
      status: "failed",
      sourceUrl,
      sourceLabel,
      fetchedAt,
      reason: "unvalidated or uncited answer",
    };
  }

  if (draft.answer === "not in the documents") {
    return { status: "not_found", sourceUrl, sourceLabel, fetchedAt };
  }

  const firstPage = draft.citedPages[0] ?? null;
  const excerptText = relevant
    .filter((c) =>
      draft.citedPages.includes(c.page_number_start ?? c.page_number_end ?? -1)
    )
    .map((c) => c.text)
    .join("\n\n") ||
    relevant.map((c) => c.text).join("\n\n");

  return {
    status: "answered",
    answer: draft.answer,
    citationId: uuidv7(),
    sourceUrl,
    sourceLabel,
    page: firstPage,
    excerptText,
    fetchedAt,
  };
}
