/**
 * Eval runner for Policy Navigator query-pipeline.
 *
 * Usage:
 *   deno run --allow-net --allow-env --allow-read --allow-write eval/runner.ts [flags]
 *
 * Required env vars:
 *   QUERY_PIPELINE_URL        Full URL to the query-pipeline Edge Function
 *   SUPABASE_ANON_KEY         Anon key for Bearer auth on pipeline calls
 *   SUPABASE_URL              Supabase project URL (for pre-run chunk verification)
 *   SUPABASE_SERVICE_ROLE_KEY Service role key (for pre-run chunk verification)
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import type { EvalCase, EvalCriterion, CriterionCheck } from "./schema.ts";
import { EvalCategory } from "./schema.ts";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = parse(Deno.args, {
  string: ["category", "cases-dir", "results-dir"],
  number: ["batch-size", "batch-delay"],
  default: {
    "batch-size": 20,
    "batch-delay": 30000,
    "cases-dir": "eval/cases",
    "results-dir": "eval/results",
  },
});

const CATEGORY_FILTER = args["category"] as string | undefined;
const BATCH_SIZE = args["batch-size"] as number;
const BATCH_DELAY = args["batch-delay"] as number;
const CASES_DIR = args["cases-dir"] as string;
const RESULTS_DIR = args["results-dir"] as string;

// ---------------------------------------------------------------------------
// Env vars
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = Deno.env.get(name);
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const QUERY_PIPELINE_URL = requireEnv("QUERY_PIPELINE_URL");
const SUPABASE_ANON_KEY = requireEnv("SUPABASE_ANON_KEY");
const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface CriterionResult {
  criterion_id: string;
  pass: boolean;
  note?: string;
}

interface CaseResult {
  case_id: string;
  category: string;
  status: "pass" | "fail" | "skipped" | "error";
  skipped_reason?: string;
  error_message?: string;
  criteria_results: CriterionResult[];
  response_ms: number;
}

// ---------------------------------------------------------------------------
// Load cases
// ---------------------------------------------------------------------------

async function loadCases(): Promise<EvalCase[]> {
  const cases: EvalCase[] = [];
  try {
    for await (const entry of walk(CASES_DIR, { exts: [".json"] })) {
      if (!entry.isFile) continue;
      const raw = await Deno.readTextFile(entry.path);
      const parsed = JSON.parse(raw) as EvalCase | EvalCase[];
      if (Array.isArray(parsed)) {
        cases.push(...parsed);
      } else {
        cases.push(parsed);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.error(`ERROR: Cases directory not found: ${CASES_DIR}`);
      Deno.exit(1);
    }
    throw err;
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Pre-run chunk ID verification
// ---------------------------------------------------------------------------

const CHUNK_TABLES = [
  "narrative_chunks",
  "vote_tallies",
  "policy_decisions",
  "budget_indicators",
  "ordinance_provisions",
] as const;

async function verifyChunkIds(
  cases: EvalCase[],
): Promise<Set<string>> {
  const allIds = new Set<string>();
  for (const c of cases) {
    for (const id of c.chunk_ids) allIds.add(id);
  }

  if (allIds.size === 0) return new Set();

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const foundIds = new Set<string>();
  const idArray = [...allIds];

  for (const table of CHUNK_TABLES) {
    const { data, error } = await supabase
      .from(table)
      .select("id")
      .in("id", idArray);
    if (error) {
      console.error(`WARN: Could not query ${table} for chunk verification: ${error.message}`);
      continue;
    }
    for (const row of data ?? []) {
      foundIds.add(row.id as string);
    }
  }

  return foundIds;
}

// ---------------------------------------------------------------------------
// Criterion evaluation (deterministic, no LLM)
// ---------------------------------------------------------------------------

const REFUSAL_PATTERNS = [
  /i (don't|do not|cannot|can't) (find|have|know|answer)/i,
  /not (in|part of) (my|the) (corpus|knowledge|documents)/i,
  /no information (available|found)/i,
  /unable to (find|answer|provide)/i,
  /outside (the scope|my knowledge)/i,
];

function isRefusalAnswer(answer: string): boolean {
  if (!answer || answer.trim().length === 0) return true;
  return REFUSAL_PATTERNS.some((p) => p.test(answer));
}

function evaluateCriterion(
  criterion: EvalCriterion,
  // deno-lint-ignore no-explicit-any
  responseData: any,
): CriterionResult {
  const check: CriterionCheck = criterion.check;
  const answer: string = responseData?.answer ?? "";
  const citations: Array<{ chunk_id: string }> = responseData?.citations ?? [];
  const temporal: boolean = responseData?.temporalFlag ?? false;

  let pass = false;
  let note: string | undefined;

  switch (check.type) {
    case "not_refusal":
      pass = !isRefusalAnswer(answer);
      if (!pass) note = "Answer appears to be a refusal or is empty";
      break;

    case "is_refusal":
      pass = isRefusalAnswer(answer);
      if (!pass) note = "Answer does not appear to be a refusal";
      break;

    case "cites_chunk": {
      const cited = citations.some((c) => c.chunk_id === check.chunk_id);
      pass = cited;
      if (!pass) note = `chunk_id ${check.chunk_id} not found in citations`;
      break;
    }

    case "temporal_flag":
      pass = temporal === true;
      if (!pass) note = "temporalFlag is false, expected true";
      break;

    case "no_temporal_flag":
      pass = temporal === false;
      if (!pass) note = "temporalFlag is true, expected false";
      break;

    case "answer_contains": {
      const sub = check.substring.toLowerCase();
      pass = answer.toLowerCase().includes(sub);
      if (!pass) note = `Answer does not contain "${check.substring}"`;
      break;
    }

    case "answer_not_contains": {
      const sub = check.substring.toLowerCase();
      pass = !answer.toLowerCase().includes(sub);
      if (!pass) note = `Answer unexpectedly contains "${check.substring}"`;
      break;
    }

    default:
      note = `Unknown check type: ${(check as { type: string }).type}`;
      pass = false;
  }

  return { criterion_id: criterion.id, pass, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------
// Pipeline call
// ---------------------------------------------------------------------------

async function callPipeline(
  query: string,
): Promise<{ data: unknown; ms: number }> {
  const start = Date.now();
  const res = await fetch(QUERY_PIPELINE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ query }),
  });
  const ms = Date.now() - start;
  const json = await res.json();
  return { data: json, ms };
}

// ---------------------------------------------------------------------------
// Sleep with countdown
// ---------------------------------------------------------------------------

async function sleepWithCountdown(ms: number): Promise<void> {
  const seconds = Math.ceil(ms / 1000);
  for (let remaining = seconds; remaining > 0; remaining--) {
    await Deno.stdout.write(new TextEncoder().encode(`\r  Batch cooldown: ${remaining}s remaining...`));
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Summary printing
// ---------------------------------------------------------------------------

function printSummary(
  results: CaseResult[],
  resultsPath: string,
): void {
  const total = results.length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errored = results.filter((r) => r.status === "error").length;
  const ran = results.filter((r) => r.status === "pass" || r.status === "fail").length;
  const passed = results.filter((r) => r.status === "pass").length;

  console.log("\n=== EVAL SUMMARY ===");
  console.log(`Total cases:   ${total}`);
  console.log(`Skipped:       ${skipped}  (missing chunk_ids)`);
  console.log(`Errored:       ${errored}  (pipeline call failures)`);
  console.log(`Ran:           ${ran}`);

  if (ran > 0) {
    console.log("\nBy category:");
    const categories = [...new Set(
      results
        .filter((r) => r.status === "pass" || r.status === "fail")
        .map((r) => r.category),
    )].sort();

    for (const cat of categories) {
      const catResults = results.filter(
        (r) => r.category === cat && (r.status === "pass" || r.status === "fail"),
      );
      const catPassed = catResults.filter((r) => r.status === "pass").length;
      const pct = Math.round((catPassed / catResults.length) * 100);
      const label = `${cat}:`.padEnd(40);
      console.log(`  ${label} ${catPassed}/${catResults.length} passed (${pct}%)`);
    }

    const overallPct = Math.round((passed / ran) * 100);
    console.log(`\nOverall pass rate: ${overallPct}% (${passed}/${ran} ran)`);
  }

  console.log(`\nResults written to: ${resultsPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Validate category flag
  if (CATEGORY_FILTER) {
    const validCategories = Object.values(EvalCategory) as string[];
    if (!validCategories.includes(CATEGORY_FILTER)) {
      console.error(
        `ERROR: Unknown category "${CATEGORY_FILTER}". Valid categories:\n  ${validCategories.join("\n  ")}`,
      );
      Deno.exit(1);
    }
  }

  // Load cases
  console.log(`Loading cases from: ${CASES_DIR}`);
  let cases = await loadCases();
  console.log(`Loaded ${cases.length} case(s)`);

  if (cases.length === 0) {
    console.log("No cases found. Exiting.");
    return;
  }

  // Filter by category
  if (CATEGORY_FILTER) {
    cases = cases.filter((c) => c.category === CATEGORY_FILTER);
    console.log(`Filtered to category "${CATEGORY_FILTER}": ${cases.length} case(s)`);
  }

  if (cases.length === 0) {
    console.log("No cases match the category filter. Exiting.");
    return;
  }

  // Pre-run chunk ID verification
  console.log("\nVerifying chunk IDs against database...");
  const foundIds = await verifyChunkIds(cases);

  const skippedCaseIds = new Set<string>();
  for (const c of cases) {
    const missing = c.chunk_ids.filter((id) => !foundIds.has(id));
    for (const id of missing) {
      console.log(`WARN: chunk_id ${id} (case ${c.id}) not found in any chunk table — case will be skipped`);
    }
    if (missing.length > 0) skippedCaseIds.add(c.id);
  }

  const runnableCases = cases.filter((c) => !skippedCaseIds.has(c.id));
  const skippedCases = cases.filter((c) => skippedCaseIds.has(c.id));

  console.log(
    `Pre-run check complete: ${runnableCases.length} runnable, ${skippedCases.length} skipped\n`,
  );

  // Build initial results for skipped cases
  const results: CaseResult[] = skippedCases.map((c) => ({
    case_id: c.id,
    category: c.category,
    status: "skipped",
    skipped_reason: "One or more chunk_ids not found in any chunk table",
    criteria_results: [],
    response_ms: 0,
  }));

  // Execute in batches
  const batches: EvalCase[][] = [];
  for (let i = 0; i < runnableCases.length; i += BATCH_SIZE) {
    batches.push(runnableCases.slice(i, i + BATCH_SIZE));
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    console.log(
      `Batch ${batchIdx + 1}/${batches.length} — ${batch.length} case(s)`,
    );

    for (const evalCase of batch) {
      await Deno.stdout.write(new TextEncoder().encode(`  [${evalCase.id}] ${evalCase.category} — `));

      let caseResult: CaseResult;

      try {
        const { data: envelope, ms } = await callPipeline(evalCase.query);

        // deno-lint-ignore no-explicit-any
        const env = envelope as any;
        if (!env?.ok) {
          caseResult = {
            case_id: evalCase.id,
            category: evalCase.category,
            status: "error",
            error_message: `Pipeline returned ok=false: ${JSON.stringify(env?.error ?? env)}`,
            criteria_results: [],
            response_ms: ms,
          };
          console.log(`ERROR — ${caseResult.error_message}`);
        } else {
          const responseData = env.data;
          const criteriaResults = evalCase.criteria.map((c) =>
            evaluateCriterion(c, responseData)
          );
          const allPassed = criteriaResults.every((r) => r.pass);
          caseResult = {
            case_id: evalCase.id,
            category: evalCase.category,
            status: allPassed ? "pass" : "fail",
            criteria_results: criteriaResults,
            response_ms: ms,
          };
          const failCount = criteriaResults.filter((r) => !r.pass).length;
          console.log(
            allPassed
              ? `PASS (${ms}ms)`
              : `FAIL — ${failCount}/${criteriaResults.length} criteria failed (${ms}ms)`,
          );
        }
      } catch (err) {
        caseResult = {
          case_id: evalCase.id,
          category: evalCase.category,
          status: "error",
          error_message: err instanceof Error ? err.message : String(err),
          criteria_results: [],
          response_ms: 0,
        };
        console.log(`ERROR — ${caseResult.error_message}`);
      }

      results.push(caseResult);
    }

    // Pause between batches (not after the last one)
    if (batchIdx < batches.length - 1) {
      console.log(`\nBatch ${batchIdx + 1} complete. Waiting ${BATCH_DELAY}ms before next batch...`);
      await sleepWithCountdown(BATCH_DELAY);
    }
  }

  // Write results
  await Deno.mkdir(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsPath = join(RESULTS_DIR, `${timestamp}.json`);
  await Deno.writeTextFile(
    resultsPath,
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
  );

  printSummary(results, resultsPath);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  Deno.exit(1);
});
