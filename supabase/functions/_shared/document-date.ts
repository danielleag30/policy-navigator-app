/**
 * Real document-date derivation for PDF-derived documents (bos_minutes,
 * bos_summary, budget_pdf).
 *
 * Root cause this addresses: documents.source_published_at and
 * documents.fiscal_year are never populated for these three doc_types, so
 * any "which document is more current" logic downstream (query-pipeline
 * recency ranking) falls back to ingested_at (scrape date) — which flips
 * unpredictably whenever routine re-ingestion happens to re-scrape an old
 * document. See PR #112 (title/date ingestion gap) and the current-tax-rate
 * architectural audit for the production incident this caused.
 *
 * Two real signal sources are used, in priority order, and nothing is ever
 * fabricated — if neither yields a value, the field is left null:
 *
 *   1. The source URL. Fairfax County's own publishing structure encodes
 *      the real document date in the URL for the overwhelming majority of
 *      bos_minutes/bos_summary documents (e.g. .../2000/BOS_2000-07-10.pdf,
 *      .../2025/May13-Board-Package-Final.pdf, .../budget committee
 *      meeting/2019/mar-12/...) and the real fiscal year for 100% of
 *      budget_pdf documents (.../fy2027/advertised/...). parseDateFromUrl/
 *      parseFiscalYearFromUrl extract these deterministically. Every
 *      pattern here was verified against the live corpus before being
 *      added (see PR description) — patterns that were ambiguous in the
 *      real data (e.g. dotted M.D.YY vs YY.M.D, seen in exactly two URLs
 *      with opposite orderings) were deliberately left unhandled rather
 *      than guessed.
 *
 *   2. Already-extracted LLM data, used only when no URL date is parseable.
 *      The extractor (extractAndPersist in extractor.ts) already asks the
 *      LLM for meeting_date on every vote_tallies/policy_decisions row it
 *      writes for bos_minutes/bos_summary chunks, and fiscal_year on
 *      policy_decisions — real data, extracted for a different purpose and
 *      never rolled up to the parent documents row today. It is the
 *      fallback rather than the primary signal because a live-corpus check
 *      found it disagrees with the URL date at the YEAR level on 14% of
 *      bos_minutes documents (0% for bos_summary): the "budget committee
 *      meeting" URL bucket includes forward-looking forecast/calendar
 *      presentations whose chunks discuss *future* board-action dates
 *      (e.g. "FY 2025 Adopted Budget ... 2024-04-30"), which the
 *      extractor's meeting_date field picks up even though the
 *      presentation itself published on a different, earlier date.
 *      pickBestDate()/pickBestFiscalYear() take the mode across a
 *      document's chunks as an extra guard against one misextracted chunk.
 */

// ── Month name lookup ─────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

// Longest names first so e.g. "september" matches before "sep" truncates it.
const MONTH_ALT = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

// ── Date validation ────────────────────────────────────────────────────────

function toIsoDateOrNull(
  year: number,
  month: number,
  day: number,
): string | null {
  if (year < 1985 || year > 2035) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null; // rejects e.g. Feb 30
  }
  return `${year.toString().padStart(4, "0")}-${
    month.toString().padStart(2, "0")
  }-${day.toString().padStart(2, "0")}`;
}

// ── URL fiscal-year extraction (budget_pdf: 100% coverage, e.g. /fy2027/) ──

export function parseFiscalYearFromUrl(url: string): number | null {
  const m = url.match(/\/fy(\d{4})\//i);
  if (!m) return null;
  const fy = parseInt(m[1], 10);
  if (fy < 2000 || fy > 2050) return null;
  return fy;
}

// ── URL date extraction ─────────────────────────────────────────────────────

function nearestYearFolder(
  segments: string[],
  beforeIndex: number,
): number | null {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (/^\d{4}$/.test(segments[i])) {
      const y = parseInt(segments[i], 10);
      if (y >= 1985 && y <= 2035) return y;
    }
  }
  return null;
}

/**
 * Extract a real document date from a Fairfax County source URL.
 * Returns an ISO YYYY-MM-DD string, or null if no unambiguous pattern matches.
 */
export function parseDateFromUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  // Normalize %20 and '+' to spaces, lowercase, so every pattern below only
  // has to deal with one separator style.
  const norm = decodeURIComponent(pathname).toLowerCase();
  const segments = norm.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  const filename = segments[segments.length - 1];

  // P1 — ISO date anywhere in the filename: BOS_1990-01-08.pdf
  // (no \b anchors: '_' is a \w char, so \b would fail to match right after
  // the "BOS_" prefix these filenames always carry)
  {
    const m = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const iso = toIsoDateOrNull(+m[1], +m[2], +m[3]);
      if (iso) return iso;
    }
  }

  // P2 — "Month D[, ]YYYY" / "Month-D-YYYY" anywhere in the filename:
  // Meeting-Minutes-March-10-2026.pdf, "...June 9, 2026.pdf"
  {
    const re = new RegExp(
      `(${MONTH_ALT})[\\s-]+(\\d{1,2})(?:st|nd|rd|th)?[\\s,-]+(\\d{4})`,
      "i",
    );
    const m = filename.match(re);
    if (m) {
      const month = MONTHS[m[1].toLowerCase()];
      const iso = toIsoDateOrNull(+m[3], month, +m[2]);
      if (iso) return iso;
    }
  }

  // P3 — numeric M-D-YYYY (4-digit year): 04-22-2025 Final Summary.pdf,
  // 05-13 2025 Final Summary.pdf (day/year separator can be '-' or a space)
  // (leading \b only — a trailing \b would fail before a literal '_', which
  // several real filenames use right after the date, e.g. "..._Final-Summary")
  {
    const m = filename.match(/\b(\d{1,2})-(\d{1,2})[\s-](\d{4})/);
    if (m) {
      const iso = toIsoDateOrNull(+m[3], +m[1], +m[2]);
      if (iso) return iso;
    }
  }

  // P4 — numeric M-D-YY (2-digit year, assumed 20YY — every sample in this
  // corpus is 2024+): 07-16-24_Final-Summary.pdf, 2-6-26_Optimized.pdf
  {
    const m = filename.match(/\b(\d{1,2})-(\d{1,2})-(\d{2})(?!\d)/);
    if (m) {
      const iso = toIsoDateOrNull(2000 + +m[3], +m[1], +m[2]);
      if (iso) return iso;
    }
  }

  // P5 — six glued digits MMDDYY, only when the filename is clearly a board
  // summary (reduces false-positive risk on unrelated 6-digit numbers):
  // 092424_Final_Summary.pdf, BOS-102224_Final_Summary.pdf
  if (/(final|summary)/.test(filename)) {
    const m = filename.match(/(?:^|[-_\s])(\d{2})(\d{2})(\d{2})(?:[-_\s]|$)/);
    if (m) {
      const iso = toIsoDateOrNull(2000 + +m[3], +m[1], +m[2]);
      if (iso) return iso;
    }
  }

  // P6 — month name at the START of the filename (glued or space/dash
  // separated) followed by a day, with no year in the filename itself
  // (year comes from the /YYYY/ folder): may1-board-summary.pdf,
  // June08-board-summary.pdf, march6-board-summary.pdf, "november 18 bos
  // summary.pdf"
  {
    const re = new RegExp(`^(${MONTH_ALT})[\\s-]?(\\d{1,2})(?:[\\s_-]|$)`, "i");
    const m = filename.match(re);
    if (m) {
      const year = nearestYearFolder(segments, segments.length - 1);
      if (year !== null) {
        const iso = toIsoDateOrNull(year, MONTHS[m[1].toLowerCase()], +m[2]);
        if (iso) return iso;
      }
    }
  }

  // P7 — a whole path segment that is exactly "month[-/space]day" (the
  // budget-committee-meeting folder convention): .../2019/mar-12/...,
  // .../2017/june 13/...  Year comes from the /YYYY/ folder just before it.
  for (let i = 0; i < segments.length; i++) {
    const re = new RegExp(`^(${MONTH_ALT})[\\s-]?(\\d{1,2})$`, "i");
    const m = segments[i].match(re);
    if (m) {
      const year = nearestYearFolder(segments, i);
      if (year !== null) {
        const iso = toIsoDateOrNull(year, MONTHS[m[1].toLowerCase()], +m[2]);
        if (iso) return iso;
      }
    }
  }

  return null;
}

// ── Mode helpers (guard against one misextracted chunk skewing the result) ─

export function pickBestDate(
  dates: Array<string | null | undefined>,
): string | null {
  const counts = new Map<string, number>();
  for (const d of dates) {
    if (!d) continue;
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) continue;
    const iso = toIsoDateOrNull(+m[1], +m[2], +m[3]);
    if (!iso) continue;
    counts.set(iso, (counts.get(iso) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = -1;
  for (
    const [iso, count] of [...counts.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )
  ) {
    if (count > bestCount) {
      best = iso;
      bestCount = count;
    }
  }
  return best;
}

export function pickBestFiscalYear(
  years: Array<number | null | undefined>,
): number | null {
  const counts = new Map<number, number>();
  for (const y of years) {
    if (y === null || y === undefined) continue;
    if (!Number.isInteger(y) || y < 2000 || y > 2050) continue;
    counts.set(y, (counts.get(y) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: number | null = null;
  let bestCount = -1;
  for (const [fy, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = fy;
      bestCount = count;
    }
  }
  return best;
}

// ── DB-backed orchestration (shared by ingest-orchestrator + backfill) ─────

interface DbError {
  message: string;
}

interface QueryResult<T> {
  data: T | null;
  error: DbError | null;
}

interface VoteTalliesTable {
  select(columns: "meeting_date"): {
    eq(
      column: "document_id",
      value: string,
    ): PromiseLike<QueryResult<Array<{ meeting_date: string | null }>>>;
  };
}

interface PolicyDecisionsTable {
  select(columns: "meeting_date, fiscal_year"): {
    eq(
      column: "document_id",
      value: string,
    ): PromiseLike<
      QueryResult<
        Array<{ meeting_date: string | null; fiscal_year: number | null }>
      >
    >;
  };
}

export interface DocumentDateDb {
  from(table: "vote_tallies"): VoteTalliesTable;
  from(table: "policy_decisions"): PolicyDecisionsTable;
}

export interface DocumentDateMetadata {
  sourcePublishedAt: string | null;
  fiscalYear: number | null;
}

export function effectiveDateForBudgetIndicator(
  budgetStage: "advertised" | "adopted" | null | undefined,
  fiscalYear: number | null | undefined,
): { effectiveDate: string | null; effectiveDateSource: "default" | null } {
  if (
    budgetStage !== "adopted" || fiscalYear === null || fiscalYear === undefined
  ) {
    return { effectiveDate: null, effectiveDateSource: null };
  }
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2050) {
    return { effectiveDate: null, effectiveDateSource: null };
  }
  return {
    effectiveDate: `${fiscalYear - 1}-07-01`,
    effectiveDateSource: "default",
  };
}

/**
 * Compute the best real source_published_at / fiscal_year for one document.
 *
 * Prefers the URL-derived date over LLM-extracted meeting_date, based on a
 * live-corpus check (see PR description): bos_summary's extracted
 * meeting_date never disagreed with its URL folder date (0/150), but
 * bos_minutes disagreed at the YEAR level on 12/86 (14%) — because the
 * "budget committee meeting" bucket includes forward-looking forecast/
 * calendar presentations whose chunks discuss *future* board-action dates
 * (e.g. "FY 2025 Adopted Budget ... 2024-04-30"), which the extractor's
 * meeting_date field picks up even though the presentation itself was
 * published on a different, earlier date. The URL is Fairfax County's own
 * filing/publish-date structure and was not observed to be wrong; LLM
 * extraction is used only when no URL date is parseable.
 *
 * Never fabricates — returns null fields when no real signal exists.
 */
export async function computeDocumentDateMetadata(
  db: DocumentDateDb,
  documentId: string,
  docType: string,
  url: string,
): Promise<DocumentDateMetadata> {
  const isBosType = docType === "bos_minutes" || docType === "bos_summary";
  const isBudgetType = docType === "budget_pdf";

  let extractedDates: Array<string | null> = [];
  let extractedFiscalYears: Array<number | null> = [];

  if (isBosType) {
    const [{ data: vt, error: vtErr }, { data: pd, error: pdErr }] =
      await Promise.all([
        db.from("vote_tallies").select("meeting_date").eq(
          "document_id",
          documentId,
        ),
        db.from("policy_decisions").select("meeting_date, fiscal_year").eq(
          "document_id",
          documentId,
        ),
      ]);
    if (vtErr) throw new Error(`vote_tallies lookup failed: ${vtErr.message}`);
    if (pdErr) {
      throw new Error(`policy_decisions lookup failed: ${pdErr.message}`);
    }
    extractedDates = [
      ...(vt ?? []).map((r) => r.meeting_date),
      ...(pd ?? []).map((r) => r.meeting_date),
    ];
    extractedFiscalYears = (pd ?? []).map((r) => r.fiscal_year);
  }

  const sourcePublishedAt = isBudgetType
    ? parseDateFromUrl(url) // budget_pdf has no meeting_date extraction path
    : parseDateFromUrl(url) ?? pickBestDate(extractedDates);

  const fiscalYear = isBudgetType
    ? parseFiscalYearFromUrl(url)
    : pickBestFiscalYear(extractedFiscalYears);

  return { sourcePublishedAt, fiscalYear };
}
