/**
 * Unit tests for change-detection's discovery primitives: link extraction,
 * depth/prefix/recency-scoped recursion (shouldFollowLink), and cross-source
 * match_priority resolution (resolveOwnerSourceId). These are the same pure
 * functions _crawl_state.ts's checkpointed BFS calls per-URL — see that
 * module's file header for why the old whole-source crawlDiscoverySource/
 * discoverAllCandidates/resolveCandidates functions this file used to test
 * were replaced. End-to-end crawl+checkpoint behavior is covered by
 * _crawl_state_test.ts instead.
 */

import {
  type DiscoverySource,
  extractLinks,
  mapWithConcurrency,
  matchesAllowPattern,
  meetsFollowRecency,
  resolveOwnerSourceId,
  shouldFollowLink,
  trailingYearOf,
} from "./_discovery.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ── extractLinks ──────────────────────────────────────────────────────────────

Deno.test("extractLinks resolves relative hrefs against the page URL", () => {
  const html = `<a href="/board/minutes/march.pdf">March minutes</a>`;
  const links = extractLinks(
    html,
    "https://www.fairfaxcounty.gov/boardofsupervisors/board-meeting-information",
  );

  assertEquals(links, [
    "https://www.fairfaxcounty.gov/board/minutes/march.pdf",
  ]);
});

Deno.test("extractLinks passes through absolute hrefs unchanged", () => {
  const html = `<a href='https://www.fairfaxcounty.gov/budget/adopted/Overview.pdf'>Overview</a>`;
  const links = extractLinks(
    html,
    "https://www.fairfaxcounty.gov/budget/adopted",
  );

  assertEquals(links, [
    "https://www.fairfaxcounty.gov/budget/adopted/Overview.pdf",
  ]);
});

Deno.test("extractLinks skips fragment, javascript:, mailto:, and tel: hrefs", () => {
  const html = `
    <a href="#top">Top</a>
    <a href="javascript:void(0)">Toggle</a>
    <a href="mailto:clerk@fairfaxcounty.gov">Email</a>
    <a href="tel:+17035551234">Call</a>
    <a href="/real/page.pdf">Real</a>
  `;
  const links = extractLinks(html, "https://www.fairfaxcounty.gov/x");

  assertEquals(links, ["https://www.fairfaxcounty.gov/real/page.pdf"]);
});

Deno.test("extractLinks preserves exact path casing — does not lowercase", () => {
  const html = `
    <a href="https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/advertised/volume%201.pdf">Advertised</a>
    <a href="https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/Documents/fy2026/adopted/Overview.pdf">Adopted</a>
  `;
  const links = extractLinks(
    html,
    "https://www.fairfaxcounty.gov/budget/adopted",
  );

  assert(
    links.includes(
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/advertised/volume%201.pdf",
    ),
    "expected lowercase 'documents' segment preserved exactly",
  );
  assert(
    links.includes(
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/Documents/fy2026/adopted/Overview.pdf",
    ),
    "expected uppercase 'Documents' segment preserved exactly",
  );
});

Deno.test("extractLinks ignores malformed hrefs without failing the page", () => {
  const html = `<a href="https://[bad">broken</a><a href="/ok.pdf">ok</a>`;
  const links = extractLinks(html, "https://www.fairfaxcounty.gov/x");

  assertEquals(links, ["https://www.fairfaxcounty.gov/ok.pdf"]);
});

// ── shouldFollowLink: depth ───────────────────────────────────────────────────

const ROOT = "https://www.fairfaxcounty.gov/boardofsupervisors/board-meeting-information";
const MEETING_PAGE = "https://www.fairfaxcounty.gov/boardofsupervisors/meetings/march-10-2026";
const COMMITTEE_PDF =
  "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/Legislative-Committee-Agenda.pdf";

function bosMinutesSource(depth: number): DiscoverySource {
  return {
    id: "bos_minutes",
    doc_type: "bos_minutes",
    discovery_urls: [ROOT],
    discovery_depth: depth,
    allow_patterns: [
      "https://www.fairfaxcounty.gov/boardofsupervisors/sites/boardofsupervisors/files/Assets/Documents/PDF/",
    ],
  };
}

Deno.test("shouldFollowLink follows a same-hostname navigation link within discovery_depth", () => {
  const source = bosMinutesSource(2);
  assert(
    shouldFollowLink(MEETING_PAGE, ROOT, 1, source, new Set(), 500),
    "expected the depth-1 meeting page link to be followed",
  );
});

Deno.test("shouldFollowLink does not follow past discovery_depth", () => {
  const source = bosMinutesSource(1);
  assert(
    !shouldFollowLink(MEETING_PAGE, ROOT, 1, source, new Set(), 500),
    "depth 1 must not recurse into the meeting page",
  );
});

Deno.test("shouldFollowLink does not follow a terminal candidate link (matches allow_patterns)", () => {
  const source = bosMinutesSource(2);
  assert(
    !shouldFollowLink(COMMITTEE_PDF, MEETING_PAGE, 1, source, new Set(), 500),
    "a link matching allow_patterns is a candidate, not something to recurse into",
  );
});

Deno.test("shouldFollowLink does not follow a link to a different hostname", () => {
  const externalLink = "https://example.com/unrelated.pdf";
  const source = bosMinutesSource(2);
  assert(
    !shouldFollowLink(externalLink, ROOT, 1, source, new Set(), 500),
    "cross-hostname links must never be recursed into",
  );
});

Deno.test("shouldFollowLink does not re-follow an already-visited link", () => {
  const source = bosMinutesSource(2);
  const visited = new Set([MEETING_PAGE]);
  assert(
    !shouldFollowLink(MEETING_PAGE, ROOT, 1, source, visited, 500),
    "an already-visited link must not be queued again",
  );
});

Deno.test("shouldFollowLink stops once the visited set reaches maxPages", () => {
  const source = bosMinutesSource(2);
  const visited = new Set(["https://www.fairfaxcounty.gov/filler"]);
  assert(
    !shouldFollowLink(MEETING_PAGE, ROOT, 1, source, visited, 1),
    "the maxPages safety cap must stop further recursion",
  );
});

// ── shouldFollowLink: discovery_link_prefix scoping ───────────────────────────

const BUDGET_ROOT = "https://www.fairfaxcounty.gov/budget/budget-committee-meetings";
const BUDGET_MEETING_PAGE =
  "https://www.fairfaxcounty.gov/budget/board-supervisors-budget-committee-meeting-march-10-2026";
const GLOBAL_NAV_LINK = "https://www.fairfaxcounty.gov/elections/";

function budgetCommitteeMeetingSource(): DiscoverySource {
  return {
    id: "budget_committee_meeting",
    doc_type: "bos_minutes",
    discovery_urls: [BUDGET_ROOT],
    discovery_depth: 2,
    allow_patterns: [
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/",
    ],
    discovery_link_prefix: "https://www.fairfaxcounty.gov/budget/",
  };
}

Deno.test("shouldFollowLink does not follow a same-hostname link outside discovery_link_prefix", () => {
  const source = budgetCommitteeMeetingSource();
  assert(
    !shouldFollowLink(GLOBAL_NAV_LINK, BUDGET_ROOT, 1, source, new Set(), 500),
    "the out-of-scope nav link must not be followed",
  );
});

Deno.test("shouldFollowLink still follows a link inside discovery_link_prefix", () => {
  const source = budgetCommitteeMeetingSource();
  assert(
    shouldFollowLink(
      BUDGET_MEETING_PAGE,
      BUDGET_ROOT,
      1,
      source,
      new Set(),
      500,
    ),
    "expected the in-scope meeting page to be followed",
  );
});

Deno.test("shouldFollowLink without discovery_link_prefix follows every same-hostname link (unchanged default)", () => {
  const source: DiscoverySource = {
    ...budgetCommitteeMeetingSource(),
    discovery_link_prefix: undefined,
  };
  assert(
    shouldFollowLink(GLOBAL_NAV_LINK, BUDGET_ROOT, 1, source, new Set(), 500),
    "with no prefix set, out-of-section links should still be followed as before",
  );
});

// ── meetsFollowRecency / shouldFollowLink: discovery_follow_min_year scoping ──

const OLD_MEETING_PAGE =
  "https://www.fairfaxcounty.gov/budget/board-supervisors-budget-committee-meeting-march-8-2008";
const UNDATED_SECTION_LINK = "https://www.fairfaxcounty.gov/budget/budget-archives";

Deno.test("trailingYearOf extracts a trailing 4-digit year from the path", () => {
  assertEquals(trailingYearOf(BUDGET_MEETING_PAGE), 2026);
  assertEquals(trailingYearOf(OLD_MEETING_PAGE), 2008);
  assertEquals(trailingYearOf(UNDATED_SECTION_LINK), null);
});

Deno.test("shouldFollowLink does not follow a dated meeting page older than discovery_follow_min_year", () => {
  const source: DiscoverySource = {
    ...budgetCommitteeMeetingSource(),
    discovery_follow_min_year: 2024,
  };
  assert(
    !shouldFollowLink(OLD_MEETING_PAGE, BUDGET_ROOT, 1, source, new Set(), 500),
    "a 2008-dated page must not be followed when discovery_follow_min_year is 2024",
  );
});

Deno.test("shouldFollowLink still follows a dated meeting page at or after discovery_follow_min_year", () => {
  const source: DiscoverySource = {
    ...budgetCommitteeMeetingSource(),
    discovery_follow_min_year: 2024,
  };
  assert(
    shouldFollowLink(
      BUDGET_MEETING_PAGE,
      BUDGET_ROOT,
      1,
      source,
      new Set(),
      500,
    ),
    "expected the 2026-dated meeting page to still be followed",
  );
});

Deno.test("shouldFollowLink still follows undated section links regardless of discovery_follow_min_year", () => {
  const source: DiscoverySource = {
    ...budgetCommitteeMeetingSource(),
    discovery_follow_min_year: 2024,
  };
  assert(
    shouldFollowLink(
      UNDATED_SECTION_LINK,
      BUDGET_ROOT,
      1,
      source,
      new Set(),
      500,
    ),
    "a link with no trailing year is unaffected by discovery_follow_min_year",
  );
});

Deno.test("meetsFollowRecency without discovery_follow_min_year accepts dated links of any year (unchanged default)", () => {
  const source = budgetCommitteeMeetingSource();
  assert(
    meetsFollowRecency(OLD_MEETING_PAGE, source),
    "with no min year set, old dated pages should still be accepted as before",
  );
});

// ── matchesAllowPattern / resolveOwnerSourceId: match_priority resolution ────

const BUDGET_ADVERTISED_PDF =
  "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/fy2027/advertised/volume%201.pdf";
const BUDGET_COMMITTEE_PDF =
  "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2026/mar-10/CIP.pdf";
const IRRELEVANT_LINK = "https://www.fairfaxcounty.gov/budget/nav/contact-us";

function budgetAdvertisedSource(): DiscoverySource {
  return {
    id: "budget_pdf_advertised",
    doc_type: "budget_pdf",
    discovery_urls: ["https://www.fairfaxcounty.gov/budget/advertised"],
    discovery_depth: 1,
    allow_patterns: [
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/",
    ],
    match_priority: 2,
  };
}

function budgetCommitteeSource(): DiscoverySource {
  return {
    id: "budget_committee_meeting",
    doc_type: "bos_minutes",
    discovery_urls: ["https://www.fairfaxcounty.gov/budget/"],
    discovery_depth: 2,
    allow_patterns: [
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/",
    ],
    match_priority: 1,
  };
}

Deno.test("matchesAllowPattern is false for a link matching no allow_pattern", () => {
  assert(
    !matchesAllowPattern(IRRELEVANT_LINK, budgetAdvertisedSource()),
    "an irrelevant nav link must not match the source's allow_patterns",
  );
});

Deno.test("matchesAllowPattern supports regex: allow_patterns for case-varied county paths", () => {
  const source: DiscoverySource = {
    id: "zoning_recently_adopted_amendments",
    doc_type: "bos_summary",
    discovery_urls: [
      "https://www.fairfaxcounty.gov/planning-development/zoning-ordinance/amendments/recently-adopted",
    ],
    discovery_depth: 1,
    allow_patterns: [
      "regex:^https://www\\.fairfaxcounty\\.gov/planning-development/sites/planning-development/files/Assets/[Dd]ocuments/[Zz]oning%20[Oo]rdinance/[Aa]dopted%20[Aa]mendments/",
    ],
  };

  assert(
    matchesAllowPattern(
      "https://www.fairfaxcounty.gov/planning-development/sites/planning-development/files/Assets/Documents/zoning%20ordinance/adopted%20amendments/ZO-112_2-2024-7.pdf",
      source,
    ),
    "regex allow_pattern must cover mixed-casing Drupal paths",
  );
});

Deno.test("resolveOwnerSourceId returns null when a URL matches no source's allow_patterns", () => {
  assertEquals(
    resolveOwnerSourceId(IRRELEVANT_LINK, [budgetAdvertisedSource()]),
    null,
  );
});

Deno.test("resolveOwnerSourceId gives the ambiguous URL to the lower match_priority number", () => {
  // BUDGET_COMMITTEE_PDF starts with both sources' allow_patterns — the more
  // specific budget_committee_meeting source (priority 1) must win over the
  // broader budget_pdf_advertised source (priority 2), per the scraper_notes
  // warning in seed-sources.json.
  const sources = [budgetAdvertisedSource(), budgetCommitteeSource()];
  assertEquals(
    resolveOwnerSourceId(BUDGET_COMMITTEE_PDF, sources),
    "budget_committee_meeting",
  );
  assertEquals(
    resolveOwnerSourceId(BUDGET_ADVERTISED_PDF, sources),
    "budget_pdf_advertised",
  );
});

Deno.test("resolveOwnerSourceId lets an explicit match_priority beat a source with none set", () => {
  const noPrioritySource: DiscoverySource = {
    id: "no_priority",
    doc_type: "budget_pdf",
    discovery_urls: ["https://www.fairfaxcounty.gov/budget/"],
    discovery_depth: 1,
    allow_patterns: [
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/",
    ],
  };
  assertEquals(
    resolveOwnerSourceId(BUDGET_COMMITTEE_PDF, [
      noPrioritySource,
      budgetCommitteeSource(),
    ]),
    "budget_committee_meeting",
  );
});

// ── mapWithConcurrency ─────────────────────────────────────────────────────────

Deno.test("mapWithConcurrency preserves input order regardless of completion order", async () => {
  const items = [30, 10, 20];
  const results = await mapWithConcurrency(
    items,
    3,
    (ms) => new Promise<number>((resolve) => setTimeout(() => resolve(ms), ms)),
  );

  assertEquals(results, [30, 10, 20]);
});

Deno.test("mapWithConcurrency never runs more than `concurrency` calls at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return item;
  });

  assert(maxInFlight <= 2, `expected at most 2 in flight, saw ${maxInFlight}`);
});
