import {
  buildCurrentIdentityIndex,
  DEFAULT_HISTORICAL_SUPPLEMENTS,
  extractCitationKey,
  headingMatchesHistoricalChapter,
  resolveHistoricalIdentity,
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
});

const MUNICODE_SRC = new URL(
  "../supabase/functions/ingest-orchestrator/municode.ts",
  import.meta.url,
).pathname;
const INDEX_SRC = new URL(
  "../supabase/functions/ingest-orchestrator/index.ts",
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
