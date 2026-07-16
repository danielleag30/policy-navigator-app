import {
  buildCurrentIdentityIndex,
  CITATION_CONTENT_SIMILARITY_THRESHOLD,
  contentSimilarity,
  DEFAULT_HISTORICAL_SUPPLEMENTS,
  EXTENDED_HISTORICAL_CHAPTER_TARGETS,
  EXTENDED_HISTORICAL_SUPPLEMENTS,
  extractCitationKey,
  headingMatchesHistoricalChapter,
  historicalEmbeddingRetryDelayMinutes,
  normalizeOnlineDate,
  resolveHistoricalIdentity,
  scheduleHistoricalEmbeddingRetry,
  selectHistoricalJobs,
} from "../supabase/functions/ingest-orchestrator/_municode-helpers.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("selectHistoricalJobs keeps the bounded default supplement set and excludes latest", () => {
  const jobs = [
    { Id: 1, Name: "Supplement 125", OnlineDate: "2014-01-01T00:00:00" },
    { Id: 2, Name: "Supplement 126", OnlineDate: "2014-03-01T00:00:00" },
    { Id: 3, Name: "Supplement 156", OnlineDate: "2019-09-11T00:00:00" },
    { Id: 4, Name: "Supplement 157", OnlineDate: "2019-11-19T00:00:00" },
    { Id: 5, Name: "Supplement 179", OnlineDate: "2026-01-01T00:00:00" },
  ];

  const selected = selectHistoricalJobs(
    jobs,
    "5",
    DEFAULT_HISTORICAL_SUPPLEMENTS,
  );

  assertEquals(
    selected.map((job) => job.supplementNumber),
    [126, 156, 157],
  );
  assertEquals(
    selected.map((job) => job.onlineDate),
    ["2014-03-01", "2019-09-11", "2019-11-19"],
  );
  assert(
    selected.every((job) => job.jobId !== "5"),
    "latest/current job must not be inserted as a superseded historical snapshot",
  );
});

Deno.test("normalizeOnlineDate preserves the date part without timezone drift", () => {
  assertEquals(normalizeOnlineDate("2019-09-11T00:00:00"), "2019-09-11");
  assertEquals(normalizeOnlineDate("2019-11-19"), "2019-11-19");
});

Deno.test("extractCitationKey prefers section citations over chapter citations", () => {
  const key = extractCitationKey(
    "Chapter 4. Taxation and Finance",
    "Sec. 4-6-1. Utility tax imposed.",
  );
  assertEquals(key, "section:4-6-1");
});

Deno.test("extractCitationKey falls back to chapter citations for chapter-level repeals", () => {
  assertEquals(
    extractCitationKey("Chapter 9.1 Communications", "Repealed."),
    "chapter:9.1",
  );
});

Deno.test("resolveHistoricalIdentity maps changed node ids through citation fallback", () => {
  const index = buildCurrentIdentityIndex([
    {
      municode_node_id: "FACOCO_CH4_ART6_SEC4-6-1_CURRENT",
      section_title: "Sec. 4-6-1. Utility tax imposed.",
      content: "Current utility tax text",
    },
  ]);

  const identity = resolveHistoricalIdentity({
    rawNodeId: "FACOCO_SUP156_DIFFERENT_NODE",
    heading: "Sec. 4-6-1. Utility tax imposed.",
    content: "Older utility tax text",
    currentNodeIds: index.currentNodeIds,
    citationToCurrentNodeId: index.citationToCurrentNodeId,
    citationToCurrentContent: index.citationToCurrentContent,
  });

  assertEquals(identity.strategy, "citation-current-node");
  assertEquals(identity.nodeId, "FACOCO_CH4_ART6_SEC4-6-1_CURRENT");
  assertEquals(identity.citationKey, "section:4-6-1");
});

Deno.test("resolveHistoricalIdentity preserves repealed historical nodes with no current citation match", () => {
  const index = buildCurrentIdentityIndex([
    {
      municode_node_id: "FACOCO_CH9.2CATE",
      section_title: "Chapter 9.2 Cable Television",
      content: "Current cable television chapter",
    },
  ]);

  const identity = resolveHistoricalIdentity({
    rawNodeId: "FACOCO_CH9.1CORE35-19-9.2",
    heading: "Chapter 9.1 Communications",
    content: "Franchise provisions for communications systems.",
    currentNodeIds: index.currentNodeIds,
    citationToCurrentNodeId: index.citationToCurrentNodeId,
    citationToCurrentContent: index.citationToCurrentContent,
  });

  assertEquals(identity.strategy, "historical-node");
  assertEquals(identity.nodeId, "FACOCO_CH9.1CORE35-19-9.2");
  assertEquals(identity.citationKey, "chapter:9.1");
});

Deno.test("headingMatchesHistoricalChapter limits the initial backfill to the scoped chapter roots", () => {
  assert(
    headingMatchesHistoricalChapter("Chapter 9.1 Communications"),
    "9.1 should match",
  );
  assert(
    headingMatchesHistoricalChapter("Chapter 9.2 Cable Television"),
    "9.2 should match",
  );
  assert(
    !headingMatchesHistoricalChapter("Chapter 4. Taxation and Finance"),
    "Chapter 4 is narrowed to Article 6 by the Municode runner, not matched as a full chapter root",
  );
  assert(
    !headingMatchesHistoricalChapter("Chapter 82 Motor Vehicles and Traffic"),
    "Chapter 82 is deliberately left for a follow-up scoped pass",
  );
  assert(
    !headingMatchesHistoricalChapter("Chapter 15.2 Noise"),
    "unscoped chapters should not be walked in the initial bounded backfill",
  );
  assert(
    !headingMatchesHistoricalChapter("Chapter 9.10 Future Cable Rules"),
    "Chapter 9.1 must not match Chapter 9.10",
  );
});

// --- DAN-119 follow-up: 18 additional real amendments outside the original
// Chapter 4 Article 6 / Chapter 9.1 / Chapter 9.2 scope. ---

Deno.test("EXTENDED_HISTORICAL_SUPPLEMENTS adds only the two supplements not already covered by the default set", () => {
  assertEquals(EXTENDED_HISTORICAL_SUPPLEMENTS, [174, 175]);
  for (const supplement of EXTENDED_HISTORICAL_SUPPLEMENTS) {
    assert(
      !(DEFAULT_HISTORICAL_SUPPLEMENTS as readonly number[]).includes(
        supplement,
      ),
      `Supp ${supplement} should not duplicate an entry already in DEFAULT_HISTORICAL_SUPPLEMENTS`,
    );
  }
});

Deno.test("EXTENDED_HISTORICAL_CHAPTER_TARGETS covers every DAN-119 candidate's confirmed supplement", () => {
  const expected: Record<number, number> = { 178: 7, 177: 3, 175: 1, 174: 3 };
  for (const [supplement, count] of Object.entries(expected)) {
    const targets = EXTENDED_HISTORICAL_CHAPTER_TARGETS.get(Number(supplement));
    assert(
      targets !== undefined,
      `Supp ${supplement} must have extended targets`,
    );
    assertEquals(
      targets!.length,
      count,
      `Supp ${supplement} should have ${count} target root(s)`,
    );
  }
  assertEquals(
    EXTENDED_HISTORICAL_CHAPTER_TARGETS.get(178)!.map((t) => t.chapterPrefix),
    [
      "Chapter 101",
      "Chapter 21",
      "Chapter 23",
      "Chapter 124.1",
      "Chapter 124.1",
      "Chapter 124.1",
      "Appendix R",
    ],
  );
  assert(
    EXTENDED_HISTORICAL_CHAPTER_TARGETS.get(178)!.find((t) =>
      t.chapterPrefix === "Appendix R"
    )!.articlePrefix === undefined,
    "Appendix R is a top-level root with no article to descend into",
  );
});

Deno.test("headingMatchesHistoricalChapter matches the new extended chapter prefixes without cross-matching similarly-numbered chapters", () => {
  assert(
    headingMatchesHistoricalChapter("CHAPTER 101. - Subdivision Provisions.", [
      "Chapter 101",
    ]),
    "Chapter 101 should match its own prefix",
  );
  assert(
    headingMatchesHistoricalChapter(
      "CHAPTER 124.1 - Erosion and Stormwater Management Ordinance.",
      ["Chapter 124.1"],
    ),
    "Chapter 124.1 should match its own prefix",
  );
  assert(
    !headingMatchesHistoricalChapter(
      "CHAPTER 12. - Tenant—Landlord Relations.",
      [
        "Chapter 124.1",
      ],
    ),
    "Chapter 12 must not match the Chapter 124.1 prefix",
  );
  assert(
    headingMatchesHistoricalChapter(
      "APPENDIX R. - Ordinance Designating Long Term Parking Restrictions.",
      [
        "Appendix R",
      ],
    ),
    "Appendix R should match as a standalone top-level root",
  );
  assert(
    headingMatchesHistoricalChapter(
      "ARTICLE 2. - Requirements for Land Disturbing Activity.",
      [
        "Article 2",
      ],
    ),
    "article-level prefixes should match the same way chapter-level ones do",
  );
});

// --- Root-cause fix (post-merge review): loadCurrentIdentityIndex() had no
// pagination, so PostgREST silently capped it at 1000 of the corpus's 3400+
// current rows. Whichever current rows landed outside that page were
// invisible to citation matching, so resolveHistoricalIdentity() fell back
// to historical-node for them by ACCIDENT, not by any deliberate branch —
// confirmed by re-running resolveHistoricalIdentity() with a COMPLETE index
// against the real corpus, which deterministically merges pure citation
// matches regardless of whether the two provisions are actually related.
//
// A citation-number match alone isn't proof of continuity: Municode
// sometimes reassigns a freed-up section number to an unrelated new
// provision. contentSimilarity() gates the merge on real textual overlap,
// calibrated against the four real DAN-119 sections below (content pulled
// verbatim from the live database): genuinely continuing provisions scored
// 0.83-0.92 Jaccard similarity; genuinely distinct provisions that only
// share a citation number scored 0.11-0.33. CITATION_CONTENT_SIMILARITY_THRESHOLD
// (0.45) sits in the gap between them.

Deno.test("contentSimilarity scores real continuing amendments above the threshold and real citation collisions below it", () => {
  // Ch. 124.1 Sec. 124.1-2-4 (Supp 178 -> current): same CBPA land-disturbing
  // provision, reworded/expanded -- a genuine continuing amendment.
  const cbpaOld =
    "In order to protect the quality of state waters and to control the discharge of stormwater pollutants from land-disturbing activities, runoff associated with land-disturbing activities in Chesapeake Bay Preservation Areas that are equal to or greater than 2,500 square feet but less than one acre are subject to the Chesapeake Bay Preservation Act.";
  const cbpaNew =
    "In accordance with Section 124.1-2-1 (A), and in order to protect the quality of state waters and to control the discharge of stormwater pollutants from land-disturbing activities, runoff associated with land-disturbing activities in Chesapeake Bay Preservation Areas that are equal to or greater than 2,500 square feet but less than one acre are subject to the requirements of subsection (B) of this section.";
  assert(
    contentSimilarity(cbpaOld, cbpaNew) >=
      CITATION_CONTENT_SIMILARITY_THRESHOLD,
    "a real continuing amendment must score at or above the merge threshold",
  );

  // Ch. 23 Sec. 23-1-5 (Supp 178 -> current): the OLD "Limitation on amount
  // of bonds to be issued" and the CURRENT "Compliance with law" are
  // unrelated provisions that happen to share a citation number.
  const bondsOld =
    "No professional bondsman shall enter into any such bond if the aggregate of the penalty of such bond and all other bonds on which he has not been released from liability is in excess of the true market value of his real estate.";
  const complianceNew =
    "Any person that is licensed under this Article as a bondsman or agent for any bondsman must comply with all applicable laws governing bondsmen in Virginia.";
  assert(
    contentSimilarity(bondsOld, complianceNew) <
      CITATION_CONTENT_SIMILARITY_THRESHOLD,
    "a real citation collision between unrelated provisions must score below the merge threshold",
  );
});

Deno.test("resolveHistoricalIdentity merges a real continuing amendment (Ch. 124.1 Sec. 124.1-2-4) via citation fallback", () => {
  const currentContent =
    "(A) In accordance with Section 124.1-2-1 (A), and in order to protect the quality of state waters and to control the discharge of stormwater pollutants from land-disturbing activities, runoff associated with land-disturbing activities in Chesapeake Bay Preservation Areas that are equal to or greater than 2,500 square feet but less than one acre are subject to the requirements of subsection (B) of this section.";
  const index = buildCurrentIdentityIndex([
    {
      municode_node_id:
        "THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4LASTACCHBAPRAR",
      section_title:
        "Section 124.1-2-4. - Land-Disturbing Activity in Chesapeake Bay Preservation Areas.",
      content: currentContent,
    },
  ]);

  const identity = resolveHistoricalIdentity({
    rawNodeId:
      "THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4CHBAPRACLASTAC",
    heading:
      "Section 124.1-2-4. - Chesapeake Bay Preservation Act Land-Disturbing Activity.",
    content:
      "(A) In order to protect the quality of state waters and to control the discharge of stormwater pollutants from land-disturbing activities, runoff associated with land-disturbing activities in Chesapeake Bay Preservation Areas that are equal to or greater than 2,500 square feet but less than one acre are subject to the Chesapeake Bay Preservation Act.",
    currentNodeIds: index.currentNodeIds,
    citationToCurrentNodeId: index.citationToCurrentNodeId,
    citationToCurrentContent: index.citationToCurrentContent,
  });

  assertEquals(identity.strategy, "citation-current-node");
  assertEquals(
    identity.nodeId,
    "THCOCOFAVI1976_CH124.1ERSTMAOR_ART2RELADIAC_S124.1-2-4LASTACCHBAPRAR",
  );
  assertEquals(identity.citationKey, "section:124.1-2-4");
});

Deno.test("resolveHistoricalIdentity preserves a real citation collision (Ch. 23 Sec. 23-1-5) as a distinct historical node", () => {
  // Real DAN-119 case: Supp 178's node for "23-1-5" held unrelated content
  // ("Limitation on amount of bonds to be issued") under a different raw
  // node id than the current "23-1-5" node ("Compliance with law") -- two
  // unconnected provisions that merely share a citation number, not one
  // provision's history. Live in production as of this fix: the historical
  // row stays under its own node id (FACOCO_CH23BO_ART1GERE_S23-1-5LIAMBOBEIS),
  // effective_date 2026-01-16, is_current=false, with no row sharing the
  // current node's identity.
  const index = buildCurrentIdentityIndex([
    {
      municode_node_id: "FACOCO_CH23BO_ART1GERE_S23-1-5COLA",
      section_title: "Section 23-1-5. - Compliance with law.",
      content:
        "Any person that is licensed under this Article as a bondsman or agent for any bondsman must comply with all applicable laws governing bondsmen in Virginia.",
    },
  ]);

  const identity = resolveHistoricalIdentity({
    rawNodeId: "FACOCO_CH23BO_ART1GERE_S23-1-5LIAMBOBEIS",
    heading: "Section 23-1-5. - Limitation on amount of bonds to be issued.",
    content:
      "No professional bondsman shall enter into any such bond if the aggregate of the penalty of such bond and all other bonds on which he has not been released from liability is in excess of the true market value of his real estate.",
    currentNodeIds: index.currentNodeIds,
    citationToCurrentNodeId: index.citationToCurrentNodeId,
    citationToCurrentContent: index.citationToCurrentContent,
  });

  assertEquals(identity.strategy, "historical-node");
  assertEquals(identity.nodeId, "FACOCO_CH23BO_ART1GERE_S23-1-5LIAMBOBEIS");
  assertEquals(identity.citationKey, "section:23-1-5");
});

Deno.test("resolveHistoricalIdentity preserves a real citation collision (Ch. 5 Sec. 5-1-25) as a distinct historical node", () => {
  // Real DAN-119 case: the old one-sentence open-container prohibition and
  // the current, substantially rewritten multi-subsection version share a
  // citation number but diverge enough in content (Jaccard ~0.33, below the
  // 0.45 threshold) to be treated as distinct rather than merged.
  const index = buildCurrentIdentityIndex([
    {
      municode_node_id:
        "FACOCO_CH5OF_ART1OFAGPUPESA_S5-1-25POOPALBECOPRPEDRALBETEANPUPL",
      section_title:
        "Section 5-1-25. - Possession of open alcoholic beverage containers prohibited and penalty for drinking alcoholic beverages or tendering to another in a public place.",
      content:
        "(a) It is unlawful for any person to possess an open alcoholic beverage container while in a public park, playground, on a public street, or on any sidewalk adjoining any public street. (b) It is unlawful for any person to take a drink of an alcoholic beverage or to offer a drink thereof to another, whether accepted or not, at or in any public place, as defined in Title 4.1 of the Code of Virginia.",
    },
  ]);

  const identity = resolveHistoricalIdentity({
    rawNodeId: "FACOCO_CH5OF_ART1OFAGPUPESA_S5-1-25POOPALBECOPR",
    heading:
      "Section 5-1-25. - Possession of open alcoholic beverage containers prohibited.",
    content:
      "It shall be unlawful for any person to possess an open alcoholic beverage container while in a public park, playground, or on a public street. Violations of this Section shall be punished as a Class 4 misdemeanor.",
    currentNodeIds: index.currentNodeIds,
    citationToCurrentNodeId: index.citationToCurrentNodeId,
    citationToCurrentContent: index.citationToCurrentContent,
  });

  assertEquals(identity.strategy, "historical-node");
  assertEquals(
    identity.nodeId,
    "FACOCO_CH5OF_ART1OFAGPUPESA_S5-1-25POOPALBECOPR",
  );
  assertEquals(identity.citationKey, "section:5-1-25");
});

Deno.test("resolveHistoricalIdentity merges a real continuing amendment (Ch. 12 Sec. 12-1-4) via citation fallback", () => {
  const currentContent =
    "(a) Any landlord who rents five (5) or more dwelling units in any one (1) multifamily building shall install: (1) Deadbolt locks that meet the requirements of the Uniform Statewide Building Code, Va. Code §§ 36-97 through -119.1, as amended, for new multifamily construction and peepholes in any exterior swing entrance door to any such unit.";
  const index = buildCurrentIdentityIndex([
    {
      municode_node_id: "FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPE",
      section_title: "Section 12-1-4. - Locks and peepholes.",
      content: currentContent,
    },
  ]);

  const identity = resolveHistoricalIdentity({
    rawNodeId: "FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPEEFJU11989",
    heading: "Section 12-1-4. - Locks and peepholes. (Effective July 1, 1989)",
    content:
      "(a) Any landlord who rents five (5) or more dwelling units in any one building shall install: (1) Deadbolt locks which meet the requirements of the Uniform Statewide Building Code for new multifamily construction and peepholes in any exterior swing entrance door to any such unit.",
    currentNodeIds: index.currentNodeIds,
    citationToCurrentNodeId: index.citationToCurrentNodeId,
    citationToCurrentContent: index.citationToCurrentContent,
  });

  assertEquals(identity.strategy, "citation-current-node");
  assertEquals(identity.nodeId, "FACOCO_CH12TEANRE_ART1INGE_S12-1-4LOPE");
  assertEquals(identity.citationKey, "section:12-1-4");
});

const MUNICODE_SRC = new URL(
  "../supabase/functions/ingest-orchestrator/municode.ts",
  import.meta.url,
).pathname;
const INDEX_SRC = new URL(
  "../supabase/functions/ingest-orchestrator/index.ts",
  import.meta.url,
).pathname;
const RETRY_MIGRATION_SRC = new URL(
  "../supabase/migrations/20260713000000_historical_embedding_retry_queue.sql",
  import.meta.url,
).pathname;

Deno.test("wiring: normal Municode resume ignores historical resume states", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  assert(
    src.includes('state?.mode !== "historical"'),
    "findResumableDocument must not let normal current ingestion drain historical queues",
  );
  assert(
    src.includes('state?.mode === "historical"'),
    "historical backfill needs its own resume lookup",
  );
});

Deno.test("wiring: drainQueue accepts the resume-state flag used by historical callers", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const signatureStart = src.indexOf("async function drainQueue(");
  assert(signatureStart !== -1, "drainQueue signature not found");
  const signatureEnd = src.indexOf(
    "): Promise<MunicodeResult>",
    signatureStart,
  );
  assert(signatureEnd !== -1, "drainQueue return type not found");
  const signature = src.slice(signatureStart, signatureEnd);
  assert(
    signature.includes("hadResumeState: boolean"),
    "drainQueue must accept the fourth hadResumeState argument used by resume callers",
  );
  assert(
    src.includes("drainQueue(resumable.state.queue, ctx, deadlineMs, true)") &&
      src.includes("drainQueue(queue, ctx, deadlineMs, false)"),
    "historical callers must pass the resume-state flag explicitly",
  );
});

Deno.test("wiring: historical root selection consults the extended per-supplement chapter targets", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  assert(
    src.includes("selectExtendedHistoricalRootNodes("),
    "selectHistoricalRootNodes must delegate to the extended-target walker",
  );
  assert(
    src.includes("EXTENDED_HISTORICAL_CHAPTER_TARGETS.get(supplementNumber)"),
    "extended targets must be looked up by the job's own supplement number",
  );
  assert(
    src.includes(
      "const roots = await selectHistoricalRootNodes(\n      baseUrl,\n      userAgent,\n      job.jobId,\n      tocPayload.Children!,\n      job.supplementNumber,\n    );",
    ),
    "the historical job loop must pass job.supplementNumber into selectHistoricalRootNodes",
  );
  assert(
    src.includes("...EXTENDED_HISTORICAL_SUPPLEMENTS,"),
    "the selected historical supplement list must include the extended supplements",
  );
});

Deno.test("wiring: loadCurrentIdentityIndex paginates instead of relying on a single unbounded select()", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const fnStart = src.indexOf("async function loadCurrentIdentityIndex(");
  assert(fnStart !== -1, "loadCurrentIdentityIndex not found");
  const fnEnd = src.indexOf("\n}\n", fnStart);
  const fn = src.slice(fnStart, fnEnd);
  assert(
    fn.includes(".range("),
    "loadCurrentIdentityIndex must page through results with .range() -- " +
      "PostgREST silently caps an unbounded select() at 1000 rows, which " +
      "made citation-based identity resolution non-deterministic once the " +
      "current-row corpus passed that size",
  );
  assert(
    /while\s*\(\s*true\s*\)|do\s*\{|for\s*\(/.test(fn),
    "loadCurrentIdentityIndex must loop across pages, not fetch a single page",
  );
});

Deno.test("wiring: historical backfill is admin-only and does not run from normal polling", async () => {
  const src = await Deno.readTextFile(INDEX_SRC);
  const flagIdx = src.indexOf("municode_historical_backfill");
  const pendingIdx = src.indexOf("if (body?.pending_ingestion_id)");
  assert(flagIdx !== -1, "admin historical backfill flag not wired");
  assert(pendingIdx !== -1, "pending ingestion branch not found");
  assert(
    flagIdx < pendingIdx,
    "historical backfill should be an explicit admin path before normal pending-ingestion handling",
  );
  assert(
    src.includes("municode_historical_backfill requires a valid admin secret"),
    "historical backfill must require ADMIN_SECRET",
  );
});

Deno.test("historical embedding retry schedule uses bounded backoff and records the failure reason", () => {
  assertEquals(historicalEmbeddingRetryDelayMinutes(1), 5);
  assertEquals(historicalEmbeddingRetryDelayMinutes(2), 15);
  assertEquals(historicalEmbeddingRetryDelayMinutes(3), 60);
  assertEquals(historicalEmbeddingRetryDelayMinutes(4), 360);

  const retry = scheduleHistoricalEmbeddingRetry(
    1,
    "embed_generation_failed",
    Date.parse("2026-07-13T12:00:00.000Z"),
  );
  assertEquals(retry.attempts, 2);
  assertEquals(retry.nextAttemptAt, "2026-07-13T12:15:00.000Z");
  assertEquals(retry.lastError, "embed_generation_failed");
});

Deno.test("wiring: historical embed timeout/null fallback schedules a row retry", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const fallbackIdx = src.indexOf(
    "if (!embedding) {\n        console.warn(\n          `[municode-history] null embedding while retrying historical provision",
  );
  assert(fallbackIdx !== -1, "null embedding fallback branch not found");
  const fallbackBlock = src.slice(
    fallbackIdx,
    src.indexOf("return { processed, complete: false };", fallbackIdx),
  );
  assert(
    fallbackBlock.includes(
      'markHistoricalEmbeddingRetry(row, "embed_generation_failed")',
    ),
    "null embedding fallback must schedule the failed historical row for retry",
  );
});

Deno.test("wiring: missing /embed URL schedules historical null rows instead of only counting them", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const noUrlIdx = src.indexOf("if (!embedUrl) {");
  assert(noUrlIdx !== -1, "missing embedUrl branch not found");
  const noUrlBlock = src.slice(
    noUrlIdx,
    src.indexOf("let processed = 0;", noUrlIdx),
  );
  assert(
    noUrlBlock.includes(
      'markHistoricalEmbeddingRetry(row, "embed_url_unavailable")',
    ),
    "missing /embed URL branch must schedule historical rows for retry",
  );
  assert(
    !noUrlBlock.includes(
      "return { processed: 0, complete: (count ?? 0) === 0 };",
    ),
    "missing /embed URL branch must not just count and exit",
  );
});

Deno.test("wiring: normal cron poll picks up due historical embedding retries before pending-ingestion polling", async () => {
  const src = await Deno.readTextFile(INDEX_SRC);
  const retryIdx = src.indexOf(
    "handleMunicodeHistoricalEmbeddingRetry(SOFT_DEADLINE_MS)",
  );
  const loopIdx = src.indexOf("runPendingIngestionLoop({");
  assert(retryIdx !== -1, "historical embedding retry pickup not wired");
  assert(loopIdx !== -1, "normal pending-ingestion poll loop not found");
  assert(
    retryIdx < loopIdx,
    "historical embedding retry pickup must run before the normal cron poll loop",
  );
});

Deno.test("wiring: historical embedding cron pickup checks for due rows before /embed preflight", async () => {
  const src = await Deno.readTextFile(MUNICODE_SRC);
  const handlerIdx = src.indexOf(
    "export async function handleMunicodeHistoricalEmbeddingRetry",
  );
  assert(handlerIdx !== -1, "historical embedding retry handler not found");
  const handler = src.slice(handlerIdx);
  const dueCountIdx = handler.indexOf(
    "const dueCount = await countHistoricalEmbeddingBacklog(null, true);",
  );
  const preflightIdx = handler.indexOf("await availableHistoricalEmbedUrl(");
  assert(dueCountIdx !== -1, "due-row count guard not found");
  assert(preflightIdx !== -1, "/embed preflight call not found");
  assert(
    dueCountIdx < preflightIdx,
    "cron pickup must avoid /embed preflight when no historical retry rows are due",
  );
});

Deno.test("migration: historical embedding retry queue and current-node partial indexes exist", async () => {
  const src = await Deno.readTextFile(RETRY_MIGRATION_SRC);
  assert(
    src.includes("historical_embedding_next_attempt_at timestamptz"),
    "retry migration must add historical_embedding_next_attempt_at",
  );
  assert(
    src.includes("ordinance_provisions_historical_embedding_retry_idx") &&
      src.includes("WHERE is_current = false") &&
      src.includes("AND embedding IS NULL"),
    "retry migration must add a due-row partial index for null historical embeddings",
  );
  assert(
    src.includes("ordinance_provisions_current_municode_node_id_idx") &&
      src.includes("ON ordinance_provisions (municode_node_id)") &&
      src.includes("WHERE is_current = true"),
    "migration must add the requested current municode_node_id partial index",
  );
});
