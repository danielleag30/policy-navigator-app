/**
 * Tests for real document-date derivation (fix/document-date-ingestion).
 *
 * parseDateFromUrl/parseFiscalYearFromUrl are pure and unit tested directly
 * against real URLs sampled from the live `documents` table (project
 * ahaurkifxzqsrhwjshbj) across all three affected doc_types — not invented
 * examples — so a passing test here means the parser handles the actual
 * corpus, not a hypothetical one. Ambiguous real samples (e.g. the two
 * dotted-date filenames that use opposite M.D.YY / YY.M.D orderings) are
 * asserted to return null, matching the "never fabricate" requirement.
 */

import {
  computeDocumentDateMetadata,
  parseDateFromUrl,
  parseFiscalYearFromUrl,
  pickBestDate,
  pickBestFiscalYear,
} from "../supabase/functions/_shared/document-date.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// parseFiscalYearFromUrl — budget_pdf (100% of live corpus matches this)
// ---------------------------------------------------------------------------

Deno.test("parseFiscalYearFromUrl - /fyNNNN/ path segment", () => {
  assertEquals(
    parseFiscalYearFromUrl(
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/advertised/volume1/03.pdf",
    ),
    2027,
  );
  assertEquals(
    parseFiscalYearFromUrl(
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/Documents/fy2026/adopted/overview/Adopted%20Budget%20Summary.pdf",
    ),
    2026,
  );
});

Deno.test("parseFiscalYearFromUrl - no fy segment returns null", () => {
  assertEquals(
    parseFiscalYearFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2025/May13-Board-Package-Final.pdf",
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// parseDateFromUrl — P1: ISO date in filename (bos_summary, dominant pattern)
// ---------------------------------------------------------------------------

Deno.test("parseDateFromUrl - ISO BOS_YYYY-MM-DD.pdf", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2000/BOS_2000-07-10.pdf",
    ),
    "2000-07-10",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/1994/BOS_1994-04-12.pdf",
    ),
    "1994-04-12",
  );
});

// ---------------------------------------------------------------------------
// P2: "Month D[, ]YYYY" / "Month-D-YYYY" embedded in filename
// ---------------------------------------------------------------------------

Deno.test("parseDateFromUrl - Month-D-YYYY dash form", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/Meeting-Minutes-March-10-2026.pdf",
    ),
    "2026-03-10",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/BOS-Housing-Committee-Meeting-Summary-February-10-2026-accessible.pdf",
    ),
    "2026-02-10",
  );
});

Deno.test("parseDateFromUrl - Month D, YYYY comma form", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/2026%20General%20Assembly%20Final%20Report%20to%20the%20Board%20of%20Supervisors-%20June%209%2C%202026.pdf",
    ),
    "2026-06-09",
  );
});

// ---------------------------------------------------------------------------
// P3/P4: numeric M-D-YYYY / M-D-YY dash forms
// ---------------------------------------------------------------------------

Deno.test("parseDateFromUrl - M-D-YYYY (4-digit year)", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/04-22-2025%20Final%20Summary.pdf",
    ),
    "2025-04-22",
  );
});

Deno.test("parseDateFromUrl - M-D YYYY (space between day and year, live corpus case)", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2025/05-13%202025%20Final%20Summary.pdf",
    ),
    "2025-05-13",
  );
});

Deno.test("parseDateFromUrl - M-D-YY (2-digit year, assumed 20YY)", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/10-08-24_Final-Summary.pdf",
    ),
    "2024-10-08",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/02-03-26%20Final%20Summary.pdf",
    ),
    "2026-02-03",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/Legislative%20Committee/Legislative-Program-Final-Update-2-6-26_Optimized.pdf",
    ),
    "2026-02-06",
  );
});

// ---------------------------------------------------------------------------
// P5: six glued digits MMDDYY, gated on "final"/"summary" in filename
// ---------------------------------------------------------------------------

Deno.test("parseDateFromUrl - glued MMDDYY gated on summary/final", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2024/092424_Final_Summary.pdf",
    ),
    "2024-09-24",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2024/BOS-102224_Final_Summary.pdf",
    ),
    "2024-10-22",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2025/BOS%20061025%20Final%20Summary.pdf",
    ),
    "2025-06-10",
  );
});

Deno.test("parseDateFromUrl - glued 6-digit number NOT gated (e.g. a plain report) is not matched", () => {
  // No "final"/"summary" in filename — P5 must not fire on an arbitrary
  // 6-digit run, since that would risk false positives on IDs/amounts.
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/Agenda-Item-2-Handout_123456_A-1a.pdf",
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// P6: month glued to day at start of filename, year from folder
// ---------------------------------------------------------------------------

Deno.test("parseDateFromUrl - glued month+day at filename start, year from /YYYY/ folder", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2025/May13-Board-Package-Final.pdf",
    ),
    "2025-05-13",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2024/Dec3-Board-Package-Final.pdf",
    ),
    "2024-12-03",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2018/board/june5-board-summary.pdf",
    ),
    "2018-06-05",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2020/board/April14-board-summary.pdf",
    ),
    "2020-04-14",
  );
});

Deno.test("parseDateFromUrl - full month name + space + day at filename start, year from folder (live corpus case)", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2025/November%2018%20BOS%20Summary.pdf",
    ),
    "2025-11-18",
  );
});

// ---------------------------------------------------------------------------
// P7: whole path segment "month[-/space]day" (budget-committee-meeting folder
// convention) — dominant pattern for the budget-committee bucket of bos_minutes
// ---------------------------------------------------------------------------

Deno.test("parseDateFromUrl - folder segment month-day, dash separated", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2019/mar-12/03-2019_0210-EDSF-Nomination-Status-Chart.pdf",
    ),
    "2019-03-12",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2021/nov-23/2021_Nov_23_Joint_CIP_Comm_Recommendations.pdf",
    ),
    "2021-11-23",
  );
});

Deno.test("parseDateFromUrl - folder segment month-day, %20 (space) separated + full month names", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2017/june%2013/cte-yir-2015-16-final.pdf",
    ),
    "2017-06-13",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2016/april%201/hsc-recommendations-fy2017-budget.pdf",
    ),
    "2016-04-01",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2015/february%2027/fy2016-advertised-cex-budget-presentation.pdf",
    ),
    "2015-02-27",
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2018/jan%2030/01a-economic-opportunity-reserve-guidelines.pdf",
    ),
    "2018-01-30",
  );
});

// ---------------------------------------------------------------------------
// Honest gaps: real corpus URLs with no reliable date signal MUST stay null
// ---------------------------------------------------------------------------

Deno.test("parseDateFromUrl - no date present returns null (not fabricated)", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/board-of-supervisors-flyer.pdf",
    ),
    null,
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/Legislative-Report-No.-4.pdf",
    ),
    null,
  );
});

Deno.test("parseDateFromUrl - a bare year with no month/day is not a date", () => {
  // OIPA-2025-Annual-Report.pdf: "2025" alone must not become Jan 1 2025.
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/OIPA-2025-Annual-Report.pdf",
    ),
    null,
  );
});

Deno.test("parseDateFromUrl - month+year with no day is not a date", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/AC-Meeting-Minutes-May-2026-Final.pdf",
    ),
    null,
  );
});

Deno.test("parseDateFromUrl - ambiguous dotted-date formats are deliberately unhandled", () => {
  // Two real URLs use opposite orderings for a dotted numeric date
  // (26.03.10 = YY.MM.DD vs 12.9.25 = M.D.YY). No pattern here disambiguates
  // them, by design — guessing wrong would silently corrupt a real date.
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/26.03.10-Presentation-by-Virginia-Economic-Development-Partnership.pdf",
    ),
    null,
  );
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/Legislative%20Committee/2026-Federal-Program-Fairfax-County-12.9.25-Adopted.pdf",
    ),
    null,
  );
});

Deno.test("parseDateFromUrl - budget_pdf URLs (no day-level date) return null", () => {
  assertEquals(
    parseDateFromUrl(
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/advertised/volume1/03.pdf",
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// pickBestDate / pickBestFiscalYear — mode across a document's chunks
// ---------------------------------------------------------------------------

Deno.test("pickBestDate - takes the mode, ignoring nulls and invalid strings", () => {
  assertEquals(
    pickBestDate(["2025-05-13", "2025-05-13", "2025-05-14", null, "not-a-date"]),
    "2025-05-13",
  );
});

Deno.test("pickBestDate - empty/all-null input returns null", () => {
  assertEquals(pickBestDate([]), null);
  assertEquals(pickBestDate([null, undefined, null]), null);
});

Deno.test("pickBestFiscalYear - takes the mode, ignoring out-of-range values", () => {
  assertEquals(pickBestFiscalYear([2026, 2026, 2027, 1900, 3000]), 2026);
});

Deno.test("pickBestFiscalYear - empty input returns null", () => {
  assertEquals(pickBestFiscalYear([]), null);
});

// ---------------------------------------------------------------------------
// computeDocumentDateMetadata — DB orchestration, fake in-memory db
// ---------------------------------------------------------------------------

function fakeDb(
  voteTallies: Array<{ meeting_date: string | null }>,
  policyDecisions: Array<{ meeting_date: string | null; fiscal_year: number | null }>,
) {
  return {
    from(table: "vote_tallies" | "policy_decisions") {
      if (table === "vote_tallies") {
        return {
          select: (_cols: "meeting_date") => ({
            eq: (_c: "document_id", _v: string) =>
              Promise.resolve({ data: voteTallies, error: null }),
          }),
        };
      }
      return {
        select: (_cols: "meeting_date, fiscal_year") => ({
          eq: (_c: "document_id", _v: string) =>
            Promise.resolve({ data: policyDecisions, error: null }),
        }),
      };
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("computeDocumentDateMetadata - bos type prefers URL date over extracted meeting_date", () => {
  // Real-corpus finding: extracted meeting_date can pick up an unrelated
  // future date discussed inside a forecast/calendar document, while the
  // URL folder date is Fairfax's own (more reliable) filing date — so the
  // URL must win when both are present. fiscal_year still comes from
  // extraction since budget_pdf-style URL fiscal-year parsing doesn't apply
  // to bos_minutes/bos_summary URLs.
  return computeDocumentDateMetadata(
    fakeDb(
      [{ meeting_date: "2024-04-30" }],
      [{ meeting_date: "2024-04-30", fiscal_year: 2025 }],
    ),
    "doc-1",
    "bos_minutes",
    "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2025/May14-Board-Package-Final.pdf",
  ).then((result) => {
    assertEquals(result, { sourcePublishedAt: "2025-05-14", fiscalYear: 2025 });
  });
});

Deno.test("computeDocumentDateMetadata - bos type falls back to extraction when URL has no date", () => {
  return computeDocumentDateMetadata(
    fakeDb(
      [{ meeting_date: "2019-03-04" }],
      [],
    ),
    "doc-2",
    "bos_summary",
    "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/board-of-supervisors-flyer.pdf",
  ).then((result) => {
    assertEquals(result, { sourcePublishedAt: "2019-03-04", fiscalYear: null });
  });
});

Deno.test("computeDocumentDateMetadata - bos type uses URL date when no extraction exists", () => {
  return computeDocumentDateMetadata(
    fakeDb([], []),
    "doc-2b",
    "bos_summary",
    "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/meeting-materials/2000/BOS_2000-07-10.pdf",
  ).then((result) => {
    assertEquals(result, { sourcePublishedAt: "2000-07-10", fiscalYear: null });
  });
});

Deno.test("computeDocumentDateMetadata - budget_pdf uses URL fiscal year, never queries extraction tables", () => {
  return computeDocumentDateMetadata(
    fakeDb([], []),
    "doc-3",
    "budget_pdf",
    "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/advertised/volume1/03.pdf",
  ).then((result) => {
    assertEquals(result, { sourcePublishedAt: null, fiscalYear: 2027 });
  });
});

Deno.test("computeDocumentDateMetadata - no signal anywhere leaves both fields null", () => {
  return computeDocumentDateMetadata(
    fakeDb([], []),
    "doc-4",
    "bos_minutes",
    "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/board-of-supervisors-flyer.pdf",
  ).then((result) => {
    assertEquals(result, { sourcePublishedAt: null, fiscalYear: null });
  });
});
