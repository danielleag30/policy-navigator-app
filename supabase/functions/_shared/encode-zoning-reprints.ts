/**
 * EnCode Archives' full historical Zoning Ordinance reprint table — the
 * single source of truth for Fairfax County's 18 real full-ordinance-text
 * PDF reprints spanning 1941-2021
 * (https://online.encodeplus.com/regs/fairfaxcounty-va/archivedialog.aspx,
 * confirmed live 2026-07-21).
 *
 * Lives in _shared/ (not query-pipeline/_deep-historical.ts, which owned
 * this table originally) because two independent Edge Functions now need
 * it — query-pipeline/_deep-historical.ts (live-lookup slow path) and
 * encode-reprint-preingest (resumable OCR pre-ingestion, deep-historical
 * "fast path" build) — and Edge Functions don't cross-import code between
 * sibling function directories (DEPS.md / repo convention: shared code
 * lives in _shared/). _deep-historical.ts re-exports everything from here
 * so its own public API (and existing imports/tests) are unchanged.
 *
 * Each reprint documents the ordinance as amended through its label year and
 * remains the accurate historical record until the next reprint in the list
 * (or, for the last one, until zMOD's real effective date 2023-05-10 — see
 * project memory / PR #101). This table is therefore a hardcoded lookup
 * table, not a live-scraped index — mirrors ingest-orchestrator/encode.ts's
 * own documented convention of hardcoding stable-but-manually-verified
 * EnCode ids rather than re-parsing archivedialog.aspx's HTML on every
 * request. Re-verify against the live page before trusting this table if
 * EnCode's archive contents ever change.
 */

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

export const EARLIEST_REPRINT_YEAR = ENCODE_ZONING_REPRINTS[0].year; // 1941

// Mirrors ingest-orchestrator/encode.ts's DEFAULT_ENCODE_BASE_URL (same
// ENCODE_BASE_URL env var name — one secret update covers every caller of
// this module). Kept as a literal default here rather than imported from
// encode.ts for the same cross-import reason as the file header above.
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
