/**
 * eval/pool-echo-backfill.ts — compute the retrieval "pool echo" for the cases in
 * an EXISTING eval results file, without re-running the query-pipeline.
 *
 * The live per-case runner (runner.ts) now records the pool-echo columns during a
 * run. This driver backfills them onto a results file produced BEFORE that
 * instrumentation existed, so we can answer — for the current failing set —
 *
 *     did retrieval never surface the gold (RETRIEVAL-BLIND, a router/ranking
 *     problem), or did retrieval surface it and something downstream drop it
 *     (POST-RETRIEVAL, a judge-window / drafter problem)?
 *
 * It uses the SAME shipping pool-echo functions (eval/pool-echo.ts) the runner
 * uses — reconstructing the pool via the same bm25_/match_ RPCs and the shipping
 * docling-wrapper /embed path — so the numbers are apples-to-apples with a live
 * run. Gold chunk_ids and queries come from eval/cases (source of truth); pass/
 * fail and what the answer actually cited come from the results file.
 *
 * Usage:
 *   deno run --allow-net --allow-env --allow-read --allow-write \
 *     eval/pool-echo-backfill.ts \
 *     --results <path> [--status-field status_tolerant] [--out <path>] \
 *     [--cases-dir eval/cases] [--only-fail]
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HF_SPACES_DOCLING_URL (or EMBED_URL).
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import type { EvalCase } from "./schema.ts";
import {
  computeCasePoolEcho,
  embedQuery,
  type PoolEcho,
} from "./pool-echo.ts";

const args = parse(Deno.args, {
  string: ["results", "status-field", "out", "cases-dir"],
  boolean: ["only-fail"],
  default: {
    "status-field": "status_tolerant",
    "cases-dir": "eval/cases",
    "only-fail": true,
  },
});

const requireEnv = (n: string): string => {
  const v = Deno.env.get(n);
  if (!v) throw new Error(`Missing required env var: ${n}`);
  return v;
};

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const EMBED_URL = Deno.env.get("HF_SPACES_DOCLING_URL") ??
  Deno.env.get("EMBED_URL");

const RESULTS_PATH = args["results"] as string | undefined;
if (!RESULTS_PATH) throw new Error("--results <path> is required");
const STATUS_FIELD = args["status-field"] as string;
const CASES_DIR = args["cases-dir"] as string;
const ONLY_FAIL = args["only-fail"] as boolean;
const OUT_PATH = (args["out"] as string | undefined) ??
  RESULTS_PATH.replace(/\.json$/, "") + ".pool-echo.json";

// ── Load eval cases (gold + query source of truth) ────────────────────────────

const cases = new Map<string, EvalCase>();
for await (const entry of walk(CASES_DIR, { exts: [".json"] })) {
  if (!entry.isFile) continue;
  const parsed = JSON.parse(await Deno.readTextFile(entry.path)) as
    | EvalCase
    | EvalCase[];
  for (const c of Array.isArray(parsed) ? parsed : [parsed]) cases.set(c.id, c);
}

// ── Load results, pick the target set ─────────────────────────────────────────

const resultsDoc = JSON.parse(await Deno.readTextFile(RESULTS_PATH)) as {
  results: Array<Record<string, unknown>>;
};
const records = resultsDoc.results;

const statusOf = (r: Record<string, unknown>): string =>
  (r[STATUS_FIELD] ?? r["status"] ?? "unknown") as string;
const citedOf = (r: Record<string, unknown>): string[] => {
  const actual = r["actual"] as Record<string, unknown> | undefined;
  return (actual?.["citation_chunk_ids"] as string[] | undefined) ??
    (r["cited_chunk_ids"] as string[] | undefined) ?? [];
};

const targets = records.filter((r) => {
  const st = statusOf(r);
  if (ONLY_FAIL && st !== "fail") return false;
  const c = cases.get(r["case_id"] as string);
  return !!c && c.chunk_ids.length > 0; // must have a gold chunk to echo
});

console.log(
  `Loaded ${records.length} result records; ${targets.length} are ${
    ONLY_FAIL ? "FAILING " : ""
  }cases with ≥1 gold chunk_id (the pool-echo-relevant set).`,
);

// ── Precompute query embeddings in small, gentle bursts (HF Space is fragile) ─

const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const embByQuery = new Map<string, number[] | null>();
const uniqueQueries = [
  ...new Set(targets.map((r) => cases.get(r["case_id"] as string)!.query)),
];
if (EMBED_URL) {
  const BURST = 8;
  for (let i = 0; i < uniqueQueries.length; i += BURST) {
    const burst = uniqueQueries.slice(i, i + BURST);
    for (const q of burst) {
      try {
        embByQuery.set(q, await embedQuery(EMBED_URL, q));
      } catch (e) {
        embByQuery.set(q, null);
        console.error(`  embed failed: ${(e as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 400)); // rest between bursts
    await Deno.stdout.write(
      new TextEncoder().encode(
        `\r  embedded ${Math.min(i + BURST, uniqueQueries.length)}/${uniqueQueries.length} queries`,
      ),
    );
  }
  console.log();
} else {
  console.warn("No embed URL set — vector arm will be null for all cases.");
}

// ── Compute pool echo per target ──────────────────────────────────────────────

interface Augmented extends Record<string, unknown> {
  case_id: string;
  category: string;
  status: string;
  cited_gold: boolean;
  pool_echo: PoolEcho;
}

const augmented: Augmented[] = [];
let n = 0;
// Modest case-level concurrency: each case already fans its 5 tables out in
// parallel, so keep the case pool small to bound total concurrent RPCs.
const CASE_CONCURRENCY = 5;
for (let i = 0; i < targets.length; i += CASE_CONCURRENCY) {
  const slice = targets.slice(i, i + CASE_CONCURRENCY);
  const batch = await Promise.all(slice.map(async (r) => {
    const c = cases.get(r["case_id"] as string)!;
    const emb = embByQuery.get(c.query) ?? undefined;
    const echo = await computeCasePoolEcho(client, c.query, c.chunk_ids, {
      precomputedEmbedding: emb ?? undefined,
      embedUrl: emb ? undefined : EMBED_URL,
    });
    const cited = new Set(citedOf(r));
    return {
      case_id: c.id,
      category: c.category,
      status: statusOf(r),
      cited_gold: c.chunk_ids.some((id) => cited.has(id)),
      pool_echo: echo,
    } as Augmented;
  }));
  augmented.push(...batch);
  n += batch.length;
  await Deno.stdout.write(
    new TextEncoder().encode(`\r  pool-echo ${n}/${targets.length}`),
  );
}
console.log();

// ── Aggregate split ───────────────────────────────────────────────────────────

const surfaced = augmented.filter((a) => a.pool_echo.gold_in_pool);
const blind = augmented.filter((a) => !a.pool_echo.gold_in_pool);
const bm25Only = surfaced.filter((a) =>
  a.pool_echo.gold_rank_bm25 !== null && a.pool_echo.gold_rank_vector === null
);
const vecOnly = surfaced.filter((a) =>
  a.pool_echo.gold_rank_bm25 === null && a.pool_echo.gold_rank_vector !== null
);
const both = surfaced.filter((a) =>
  a.pool_echo.gold_rank_bm25 !== null && a.pool_echo.gold_rank_vector !== null
);
const vectorDegraded = augmented.filter((a) => a.pool_echo.vector_arm_error);

const pct = (num: number, den: number) =>
  den > 0 ? `${Math.round((num / den) * 100)}%` : "n/a";

console.log("\n=== RETRIEVAL-POOL SPLIT (failing set with gold) ===");
console.log(`  Denominator (failing + gold):     ${augmented.length}`);
console.log(
  `  SURFACED  gold in pool:           ${surfaced.length}  (${
    pct(surfaced.length, augmented.length)
  })  <-- POST-RETRIEVAL drop (judge/drafter)`,
);
console.log(`     - BM25 arm only:               ${bm25Only.length}`);
console.log(`     - vector arm only:             ${vecOnly.length}`);
console.log(`     - both arms:                   ${both.length}`);
console.log(
  `  BLIND     gold never surfaced:     ${blind.length}  (${
    pct(blind.length, augmented.length)
  })  <-- RETRIEVAL/ranking problem`,
);
const surfacedNotCited =
  surfaced.filter((a) => !a.cited_gold).length;
console.log(
  `\n  of SURFACED, answer did NOT cite the gold: ${surfacedNotCited}/${surfaced.length} (the drafter/judge dropped an available gold)`,
);
if (vectorDegraded.length) {
  console.log(
    `\n  NOTE: vector arm degraded on ${vectorDegraded.length} case(s); their columns reflect BM25 only.`,
  );
}

await Deno.writeTextFile(
  OUT_PATH,
  JSON.stringify(
    {
      source_results: RESULTS_PATH,
      status_field: STATUS_FIELD,
      generated_from: "eval/pool-echo-backfill.ts",
      denominator: augmented.length,
      split: {
        surfaced: surfaced.length,
        blind: blind.length,
        bm25_only: bm25Only.length,
        vector_only: vecOnly.length,
        both_arms: both.length,
        surfaced_not_cited: surfacedNotCited,
        vector_degraded: vectorDegraded.length,
      },
      cases: augmented,
    },
    null,
    2,
  ),
);
console.log(`\nWrote augmented per-case pool echo to: ${OUT_PATH}`);
