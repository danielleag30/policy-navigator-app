/**
 * Unit tests for the discovery crawler: link extraction, depth-limited
 * following, allow_pattern filtering, match_priority resolution, and casing
 * preservation. Uses fixture HTML and a fake PageFetcher — no live network.
 */

import {
  crawlDiscoverySource,
  discoverAllCandidates,
  type DiscoverySource,
  extractLinks,
  mapWithConcurrency,
  type PageFetchResult,
  resolveCandidates,
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

function sortedUrls(urls: Iterable<string>): string[] {
  return Array.from(urls).sort();
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

// ── crawlDiscoverySource: depth following ────────────────────────────────────

function fakeFetcher(
  pages: Record<string, string>,
): (url: string) => Promise<PageFetchResult> {
  return (url: string) => {
    const html = pages[url];
    if (html === undefined) {
      return Promise.resolve({ ok: false, status: 404, html: "" });
    }
    return Promise.resolve({ ok: true, status: 200, html });
  };
}

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

const twoHopPages = {
  [ROOT]: `<a href="${MEETING_PAGE}">March 10 meeting</a>`,
  [MEETING_PAGE]: `<a href="${COMMITTEE_PDF}">Legislative Committee Agenda</a>`,
};

Deno.test("crawlDiscoverySource follows nested meeting pages up to discovery_depth", async () => {
  const source = bosMinutesSource(2);
  const { discoveredLinks, errors } = await crawlDiscoverySource(
    source,
    fakeFetcher(twoHopPages),
  );

  assertEquals(errors, []);
  assert(
    discoveredLinks.has(COMMITTEE_PDF),
    "expected the depth-2 committee PDF to be discovered",
  );
  assert(
    discoveredLinks.has(MEETING_PAGE),
    "expected the depth-1 meeting page link itself to be recorded",
  );
});

Deno.test("crawlDiscoverySource does not follow past discovery_depth", async () => {
  const source = bosMinutesSource(1);
  const { discoveredLinks } = await crawlDiscoverySource(
    source,
    fakeFetcher(twoHopPages),
  );

  assert(
    !discoveredLinks.has(COMMITTEE_PDF),
    "depth 1 must not follow into the meeting page for the nested PDF",
  );
  assert(
    discoveredLinks.has(MEETING_PAGE),
    "the root page's own links are still recorded at depth 1",
  );
});

Deno.test("crawlDiscoverySource does not follow links to a different hostname", async () => {
  const externalLink = "https://example.com/unrelated.pdf";
  const pages = {
    [ROOT]: `<a href="${externalLink}">external</a>`,
  };
  const source = bosMinutesSource(2);
  const { discoveredLinks, errors } = await crawlDiscoverySource(
    source,
    fakeFetcher(pages),
  );

  assertEquals(errors, []);
  assert(
    discoveredLinks.has(externalLink),
    "the external link itself is still recorded as discovered",
  );
});

Deno.test("crawlDiscoverySource records an error for a failed page fetch", async () => {
  const source = bosMinutesSource(2);
  const { errors } = await crawlDiscoverySource(source, fakeFetcher({}));

  assertEquals(errors.length, 1);
  assertEquals(errors[0].url, ROOT);
  assertEquals(errors[0].message, "HTTP 404");
});

// ── discovery_link_prefix scoping ─────────────────────────────────────────────

const BUDGET_ROOT = "https://www.fairfaxcounty.gov/budget/budget-committee-meetings";
const BUDGET_MEETING_PAGE =
  "https://www.fairfaxcounty.gov/budget/board-supervisors-budget-committee-meeting-march-10-2026";
const BUDGET_MEETING_PDF =
  "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2026/mar-10/CIP.pdf";
const GLOBAL_NAV_LINK = "https://www.fairfaxcounty.gov/elections/";
const GLOBAL_NAV_ONLY_REACHABLE_LINK = "https://www.fairfaxcounty.gov/elections/absentee";

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

const budgetListingPages = {
  [BUDGET_ROOT]:
    `<a href="${BUDGET_MEETING_PAGE}">March 10 meeting</a><a href="${GLOBAL_NAV_LINK}">Elections</a>`,
  [BUDGET_MEETING_PAGE]: `<a href="${BUDGET_MEETING_PDF}">CIP</a>`,
  [GLOBAL_NAV_LINK]: `<a href="${GLOBAL_NAV_ONLY_REACHABLE_LINK}">Absentee</a>`,
};

Deno.test("crawlDiscoverySource does not queue a same-hostname link outside discovery_link_prefix", async () => {
  const source = budgetCommitteeMeetingSource();
  const { discoveredLinks } = await crawlDiscoverySource(
    source,
    fakeFetcher(budgetListingPages),
  );

  assert(
    discoveredLinks.has(GLOBAL_NAV_LINK),
    "the out-of-scope nav link is still recorded as discovered",
  );
  assert(
    !discoveredLinks.has(GLOBAL_NAV_ONLY_REACHABLE_LINK),
    "the crawler must not have fetched the out-of-scope nav page, so links only reachable through it are never seen",
  );
});

Deno.test("crawlDiscoverySource still follows links inside discovery_link_prefix", async () => {
  const source = budgetCommitteeMeetingSource();
  const { discoveredLinks, errors } = await crawlDiscoverySource(
    source,
    fakeFetcher(budgetListingPages),
  );

  assertEquals(errors, []);
  assert(
    discoveredLinks.has(BUDGET_MEETING_PDF),
    "expected the depth-2 PDF under the in-scope meeting page to be discovered",
  );
});

Deno.test("crawlDiscoverySource without discovery_link_prefix follows every same-hostname link (unchanged default)", async () => {
  const source: DiscoverySource = {
    ...budgetCommitteeMeetingSource(),
    discovery_link_prefix: undefined,
  };
  const { discoveredLinks } = await crawlDiscoverySource(
    source,
    fakeFetcher(budgetListingPages),
  );

  assert(
    discoveredLinks.has(GLOBAL_NAV_ONLY_REACHABLE_LINK),
    "with no prefix set, the crawler should still follow out-of-section links as before",
  );
});

// ── discovery_follow_min_year scoping ─────────────────────────────────────────

const OLD_MEETING_PAGE =
  "https://www.fairfaxcounty.gov/budget/board-supervisors-budget-committee-meeting-march-8-2008";
const OLD_MEETING_PDF =
  "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/budget%20committee%20meeting/2008/mar-8/Agenda.pdf";
const UNDATED_SECTION_LINK = "https://www.fairfaxcounty.gov/budget/budget-archives";
const UNDATED_SECTION_ONLY_REACHABLE_LINK =
  "https://www.fairfaxcounty.gov/budget/budget-archives/older-index";

const budgetListingPagesWithOldMeeting = {
  ...budgetListingPages,
  [BUDGET_ROOT]: `<a href="${BUDGET_MEETING_PAGE}">March 10 2026 meeting</a>` +
    `<a href="${OLD_MEETING_PAGE}">March 8 2008 meeting</a>` +
    `<a href="${UNDATED_SECTION_LINK}">Budget archives</a>` +
    `<a href="${GLOBAL_NAV_LINK}">Elections</a>`,
  [OLD_MEETING_PAGE]: `<a href="${OLD_MEETING_PDF}">Agenda</a>`,
  [UNDATED_SECTION_LINK]: `<a href="${UNDATED_SECTION_ONLY_REACHABLE_LINK}">Older</a>`,
};

Deno.test("crawlDiscoverySource does not follow a dated meeting page older than discovery_follow_min_year", async () => {
  const source: DiscoverySource = {
    ...budgetCommitteeMeetingSource(),
    discovery_follow_min_year: 2024,
  };
  const { discoveredLinks } = await crawlDiscoverySource(
    source,
    fakeFetcher(budgetListingPagesWithOldMeeting),
  );

  assert(
    discoveredLinks.has(OLD_MEETING_PAGE),
    "the old meeting page's own link is still recorded as discovered",
  );
  assert(
    !discoveredLinks.has(OLD_MEETING_PDF),
    "the crawler must not have followed the too-old meeting page, so its PDF is never seen",
  );
});

Deno.test("crawlDiscoverySource still follows a dated meeting page at or after discovery_follow_min_year", async () => {
  const source: DiscoverySource = {
    ...budgetCommitteeMeetingSource(),
    discovery_follow_min_year: 2024,
  };
  const { discoveredLinks } = await crawlDiscoverySource(
    source,
    fakeFetcher(budgetListingPagesWithOldMeeting),
  );

  assert(
    discoveredLinks.has(BUDGET_MEETING_PDF),
    "expected the 2026 meeting's PDF to still be discovered",
  );
});

Deno.test("crawlDiscoverySource still follows undated section links regardless of discovery_follow_min_year", async () => {
  const source: DiscoverySource = {
    ...budgetCommitteeMeetingSource(),
    discovery_follow_min_year: 2024,
  };
  const { discoveredLinks } = await crawlDiscoverySource(
    source,
    fakeFetcher(budgetListingPagesWithOldMeeting),
  );

  assert(
    discoveredLinks.has(UNDATED_SECTION_ONLY_REACHABLE_LINK),
    "a link with no trailing year is unaffected by discovery_follow_min_year",
  );
});

Deno.test("crawlDiscoverySource without discovery_follow_min_year follows dated pages of any year (unchanged default)", async () => {
  const source = budgetCommitteeMeetingSource();
  const { discoveredLinks } = await crawlDiscoverySource(
    source,
    fakeFetcher(budgetListingPagesWithOldMeeting),
  );

  assert(
    discoveredLinks.has(OLD_MEETING_PDF),
    "with no min year set, the crawler should still follow old dated pages as before",
  );
});

// ── allow_pattern filtering + match_priority resolution ──────────────────────

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

Deno.test("resolveCandidates drops links that match no allow_pattern", () => {
  const perSourceLinks = new Map([
    [
      "budget_pdf_advertised",
      new Set([BUDGET_ADVERTISED_PDF, IRRELEVANT_LINK]),
    ],
  ]);
  const candidates = resolveCandidates(perSourceLinks, [
    budgetAdvertisedSource(),
  ]);

  assertEquals(candidates.map((c) => c.url), [BUDGET_ADVERTISED_PDF]);
});

Deno.test("resolveCandidates gives the ambiguous URL to the lower match_priority number", () => {
  // BUDGET_COMMITTEE_PDF starts with both sources' allow_patterns — the more
  // specific budget_committee_meeting source (priority 1) must win over the
  // broader budget_pdf_advertised source (priority 2), per the scraper_notes
  // warning in seed-sources.json.
  const perSourceLinks = new Map([
    [
      "budget_pdf_advertised",
      new Set([BUDGET_ADVERTISED_PDF, BUDGET_COMMITTEE_PDF]),
    ],
    ["budget_committee_meeting", new Set([BUDGET_COMMITTEE_PDF])],
  ]);
  const sources = [budgetAdvertisedSource(), budgetCommitteeSource()];
  const candidates = resolveCandidates(perSourceLinks, sources);

  const committeeCandidate = candidates.find((c) => c.url === BUDGET_COMMITTEE_PDF);
  const advertisedCandidate = candidates.find((c) => c.url === BUDGET_ADVERTISED_PDF);

  assert(
    committeeCandidate !== undefined,
    "expected the shared PDF to be a candidate",
  );
  assertEquals(committeeCandidate?.sourceId, "budget_committee_meeting");
  assertEquals(committeeCandidate?.docType, "bos_minutes");
  assertEquals(advertisedCandidate?.sourceId, "budget_pdf_advertised");
  assertEquals(candidates.length, 2);
});

Deno.test("resolveCandidates lets an explicit match_priority beat a source with none set", () => {
  const noPrioritySource: DiscoverySource = {
    id: "no_priority",
    doc_type: "budget_pdf",
    discovery_urls: ["https://www.fairfaxcounty.gov/budget/"],
    discovery_depth: 1,
    allow_patterns: [
      "https://www.fairfaxcounty.gov/budget/sites/budget/files/Assets/documents/",
    ],
  };
  const perSourceLinks = new Map([
    ["no_priority", new Set([BUDGET_COMMITTEE_PDF])],
    ["budget_committee_meeting", new Set([BUDGET_COMMITTEE_PDF])],
  ]);
  const candidates = resolveCandidates(perSourceLinks, [
    noPrioritySource,
    budgetCommitteeSource(),
  ]);

  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].sourceId, "budget_committee_meeting");
});

// ── discoverAllCandidates: end-to-end across sources with a shared fetcher ───

Deno.test("discoverAllCandidates crawls each source and resolves priority across them", async () => {
  const pages: Record<string, string> = {
    "https://www.fairfaxcounty.gov/budget/advertised":
      `<a href="${BUDGET_ADVERTISED_PDF}">Vol 1</a>`,
    "https://www.fairfaxcounty.gov/budget/": `<a href="${BUDGET_COMMITTEE_PDF}">CIP</a>`,
  };
  let fetchCount = 0;
  const fetchPage = (url: string): Promise<PageFetchResult> => {
    fetchCount++;
    const html = pages[url];
    return Promise.resolve(
      html !== undefined ? { ok: true, status: 200, html } : { ok: false, status: 404, html: "" },
    );
  };

  const { candidates, errors } = await discoverAllCandidates(
    [budgetAdvertisedSource(), budgetCommitteeSource()],
    fetchPage,
  );

  assertEquals(errors, []);
  assertEquals(fetchCount, 2);
  assertEquals(
    sortedUrls(candidates.map((c) => c.url)),
    sortedUrls([BUDGET_ADVERTISED_PDF, BUDGET_COMMITTEE_PDF]),
  );

  const committeeCandidate = candidates.find((c) => c.url === BUDGET_COMMITTEE_PDF);
  assertEquals(committeeCandidate?.docType, "bos_minutes");
});

Deno.test("discoverAllCandidates tags crawl errors with the owning source", async () => {
  const fetchPage = (): Promise<PageFetchResult> =>
    Promise.resolve({ ok: false, status: 500, html: "" });

  const { errors, candidates } = await discoverAllCandidates([
    budgetAdvertisedSource(),
  ], fetchPage);

  assertEquals(candidates, []);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].sourceId, "budget_pdf_advertised");
  assertEquals(errors[0].docType, "budget_pdf");
  assertEquals(errors[0].message, "HTTP 500");
});
