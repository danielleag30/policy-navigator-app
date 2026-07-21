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
 * date and not a 2021 one). ENCODE_ZONING_REPRINTS (imported from
 * _shared/encode-zoning-reprints.ts and re-exported below unchanged — see
 * that file's header for why it moved out of here) is therefore a hardcoded
 * lookup table, not a live-scraped index — mirrors encode.ts's own documented
 * convention of hardcoding stable-but-manually-verified EnCode ids
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
 * the gate is exactly "true". The same gate also covers
 * encode-reprint-preingest (the background OCR pre-ingestion job this module
 * reads from on the fast path, see fetchPreingestedReprintBlocks below).
 *
 * FAST PATH (added alongside encode-reprint-preingest): before ever calling
 * the Docling wrapper, runDeepHistoricalLookup checks whether the selected
 * reprint has already been fully OCR'd by the background pre-ingestion job
 * (encode_reprint_preingest_state.status = 'complete') and, if so, answers
 * from the persisted encode_reprint_pages text instead — a fast DB lookup,
 * no live OCR wait. Only a reprint the background job hasn't reached yet
 * falls through to the live-OCR path below (now hitting docling-wrapper's
 * opt-in /process-ocr endpoint, not the default do_ocr=False /process, which
 * always returns 0 blocks for these scanned-image reprints).
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
import {
  type DeepHistoricalReprint,
  EARLIEST_REPRINT_YEAR,
  ENCODE_ZONING_REPRINTS,
  reprintDocUrl,
  selectReprintForYear,
} from "../_shared/encode-zoning-reprints.ts";

// ── Reprint table ─────────────────────────────────────────────────────────────
//
// Moved to _shared/encode-zoning-reprints.ts (re-exported below unchanged)
// once the encode-reprint-preingest Edge Function needed the same table —
// Edge Functions don't cross-import code between sibling function
// directories (DEPS.md / repo convention), so this became genuinely shared
// code. Every existing import of these symbols from this file keeps working.
export {
  type DeepHistoricalReprint,
  ENCODE_ZONING_REPRINTS,
  reprintDocUrl,
  selectReprintForYear,
};

/** zMOD's real effective date (2023-05-10, see project memory / PR #101) supersedes every reprint above. */
const CURRENT_ERA_BOUNDARY_YEAR = 2023;

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

The user's question could not be answered from the system's normal pre-indexed corpus, so real excerpt text was retrieved from an official historical source: the "${reprint.label}" of the Fairfax County Zoning Ordinance (EnCode Archives), which documents the ordinance as amended through ${reprint.year}.

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

Excerpts (${chunks.length} highest lexical-relevance sections from the source document, highest first):
${excerptBlock}

Output JSON only:`;
}

// ── Pre-ingested fast path ───────────────────────────────────────────────────
//
// encode-reprint-preingest (supabase/functions/encode-reprint-preingest) is a
// resumable background job that OCRs each of the 18 EnCode reprints ahead of
// time and stores per-page text in encode_reprint_pages, keyed by
// doc_library_id + page_number. When a reprint's preingest state reaches
// status = 'complete', this module answers straight from that table instead
// of paying for a live OCR fetch on every matching query.

interface PreingestDbError {
  message: string;
}

interface PreingestStateRow {
  status: "pending" | "in_progress" | "complete";
}

interface PreingestPageRow {
  page_number: number;
  text: string;
}

/** Minimal shape this module needs from a supabase-js client — narrow on
 * purpose so tests can pass an in-memory fake instead of a real db client. */
export interface PreingestDb {
  from(table: "encode_reprint_preingest_state"): {
    select(columns: string): {
      eq(column: "doc_library_id", value: string): {
        maybeSingle(): PromiseLike<
          { data: PreingestStateRow | null; error: PreingestDbError | null }
        >;
      };
    };
  };
  from(table: "encode_reprint_pages"): {
    select(columns: string): {
      eq(column: "doc_library_id", value: string): {
        order(column: string, opts: { ascending: boolean }): PromiseLike<
          { data: PreingestPageRow[] | null; error: PreingestDbError | null }
        >;
      };
    };
  };
}

/**
 * Fast path: read pre-ingested OCR'd page text for `reprint`. Returns null
 * (never `[]`) when the reprint isn't fully pre-ingested yet — status must be
 * exactly 'complete', not merely "some pages already landed" — so a partial
 * background run can never produce a false "not in the documents" refusal
 * just because the one page that would have answered the question hasn't
 * been OCR'd yet; the caller falls back to the live-OCR slow path instead.
 *
 * Returned blocks are shaped 1:1 onto the Docling wrapper's FlatBlock
 * contract (one block per page, page_no = page_number) so the exact same
 * chunkBlocks()/citation pipeline below runs unchanged regardless of source.
 */
export async function fetchPreingestedReprintBlocks(
  db: PreingestDb,
  reprint: DeepHistoricalReprint,
): Promise<FlatBlock[] | null> {
  const { data: stateRow, error: stateErr } = await db
    .from("encode_reprint_preingest_state")
    .select("status")
    .eq("doc_library_id", reprint.docLibraryId)
    .maybeSingle();
  if (stateErr) {
    throw new Error(
      `encode_reprint_preingest_state lookup failed for ${reprint.docLibraryId}: ${stateErr.message}`,
    );
  }
  if (!stateRow || stateRow.status !== "complete") return null;

  const { data: pages, error: pagesErr } = await db
    .from("encode_reprint_pages")
    .select("page_number, text")
    .eq("doc_library_id", reprint.docLibraryId)
    .order("page_number", { ascending: true });
  if (pagesErr) {
    throw new Error(
      `encode_reprint_pages lookup failed for ${reprint.docLibraryId}: ${pagesErr.message}`,
    );
  }

  return (pages ?? []).map((page, idx): FlatBlock => ({
    text: page.text,
    page_no: page.page_number,
    bbox: null,
    reading_order_index: idx,
  }));
}

// ── Docling fetch (live-OCR fallback) ───────────────────────────────────────

interface DoclingResponse {
  blocks: FlatBlock[];
  block_count: number;
  docling_version: string;
}

/**
 * Live-OCR fallback for a reprint the background job hasn't reached yet.
 * Calls the Tier 0 opt-in /process-ocr endpoint (docling-wrapper) — NOT the
 * default /process endpoint, which is always do_ocr=False and therefore
 * always returns 0 blocks for these scanned-image reprints. This is a
 * best-effort, whole-document OCR pass within the timeout budget below; it
 * degrades gracefully to a refusal (never a fabrication) if OCR can't finish
 * in time, same as every other exit in this module.
 */
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
    const resp = await fetch(`${doclingUrl.replace(/\/$/, "")}/process-ocr`, {
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

// 110s -- bumped from the pre-OCR 100s default (which matched
// ingest-orchestrator's non-OCR DOCLING_TIMEOUT_MS) now that this call hits
// the OCR-enabled /process-ocr endpoint on fallback: OCR is materially
// slower per page than native text extraction. Kept under the frontend's
// documented 190s FETCH_TIMEOUT_MS budget together with the LLM leg below
// (110s + ~67s worst-case Ollama retries = ~177s, DEPS.md) without needing a
// frontend change. This is a best-effort whole-document OCR attempt for
// reprints the background pre-ingestion job hasn't reached yet -- see
// fetchReprintBlocks; the fast path below (fetchPreingestedReprintBlocks)
// avoids this timeout entirely once a reprint is fully pre-ingested.
const DEFAULT_DOCLING_TIMEOUT_MS = 110_000;
const DEFAULT_LLM_TIMEOUT_MS = 20_000;

function sourceLabelFor(
  reprint: DeepHistoricalReprint,
  usedFastPath: boolean,
): string {
  return usedFastPath
    ? `Fairfax County Zoning Ordinance — ${reprint.label} (EnCode Archives, pre-ingested)`
    : `Fairfax County Zoning Ordinance — ${reprint.label} (EnCode Archives, live historical lookup)`;
}

/**
 * Run the full slow path: check the pre-ingested store first (fast path,
 * see fetchPreingestedReprintBlocks) and fall back to a live OCR fetch via
 * the Docling wrapper only if that reprint isn't fully pre-ingested yet.
 * Either way, chunk the resulting blocks, lexically rank chunks against the
 * query, and draft a page-cited answer. Every non-"answered" exit is a
 * refusal, never a guess (see file header NEVER-FABRICATE GUARANTEE).
 * Extended timeouts on the live-fetch fallback (default 110s Docling OCR +
 * up to 20s per Ollama attempt, independently retried up to 3x by
 * ollamaChat) intentionally exceed the normal path's 15s OLLAMA_TIMEOUT_MS
 * ceiling — see DEPS.md for the documented worst-case budget. Only this call
 * site passes a timeoutMsOverride to ollamaChat; the normal path's calls are
 * untouched.
 */
export async function runDeepHistoricalLookup(
  db: PreingestDb,
  userQuery: string,
  reprint: DeepHistoricalReprint,
): Promise<DeepHistoricalOutcome> {
  const sourceUrl = reprintDocUrl(reprint);
  const fetchedAt = new Date().toISOString();

  let blocks: FlatBlock[];
  let usedFastPath: boolean;
  const preingested = await fetchPreingestedReprintBlocks(db, reprint);
  if (preingested !== null) {
    blocks = preingested;
    usedFastPath = true;
    console.log(
      `[deep-historical] fast path: ${blocks.length} pre-ingested page(s) for ${reprint.label}`,
    );
  } else {
    usedFastPath = false;
    const doclingTimeoutMs = parseInt(
      Deno.env.get("DEEP_HISTORICAL_DOCLING_TIMEOUT_MS") ??
        String(DEFAULT_DOCLING_TIMEOUT_MS),
      10,
    );
    try {
      blocks = await fetchReprintBlocks(sourceUrl, doclingTimeoutMs);
    } catch (e) {
      console.error(
        `[deep-historical] Docling fetch failed: ${(e as Error).message}`,
      );
      return {
        status: "failed",
        sourceUrl,
        sourceLabel: sourceLabelFor(reprint, usedFastPath),
        fetchedAt,
        reason: (e as Error).message,
      };
    }
  }

  const sourceLabel = sourceLabelFor(reprint, usedFastPath);
  const llmTimeoutMs = parseInt(
    Deno.env.get("DEEP_HISTORICAL_LLM_TIMEOUT_MS") ??
      String(DEFAULT_LLM_TIMEOUT_MS),
    10,
  );

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
