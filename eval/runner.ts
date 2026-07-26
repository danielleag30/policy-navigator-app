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
 *
 * The grading functions in this module (`evaluateCriterion`, `tolerantContains`,
 * `isRefusalAnswer`, `normalizeAnswerText`) are pure and exported so tests can
 * exercise the REAL shipping grader — not a re-implemented copy. All live-run
 * machinery (CLI flags, env vars, network, DB) is guarded behind
 * `import.meta.main`, so importing this module has no side effects.
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import type { CriterionCheck, EvalCase, EvalCriterion } from "./schema.ts";
import { EvalCategory } from "./schema.ts";
import { computeCasePoolEcho, type GoldRankDetail } from "./pool-echo.ts";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface CriterionResult {
  criterion_id: string;
  pass: boolean;
  note?: string;
}

export interface CaseResult {
  case_id: string;
  category: string;
  status: "pass" | "fail" | "skipped" | "error";
  skipped_reason?: string;
  error_message?: string;
  criteria_results: CriterionResult[];
  response_ms: number;
  // Persisted per-case evidence (measurement fix): every completed run must
  // leave a durable artifact that records what the system actually said, so
  // flip attribution never again has to be *bounded* for lack of data.
  answer?: string; // the actual answer text returned by the pipeline
  cited_chunk_ids?: string[]; // chunk_ids the pipeline cited
  // Split-metric inputs (see computeSummaryMetrics): whether the case expects a
  // substantive answer, and whether the system refused/fell through.
  expects_answer?: boolean;
  refused?: boolean;
  // ── Retrieval-pool instrumentation ("pool echo", additive; see pool-echo.ts) ──
  // Distinct, per case, from whether the answer CITED the gold: these record
  // whether the expected gold chunk_id(s) were in the retrieval candidate pool at
  // all, and at what per-arm rank. This is what lets a failing case be attributed
  // to RETRIEVAL (gold never surfaced) vs POST-RETRIEVAL (surfaced, then dropped
  // by the judge/drafter). Undefined for cases with no gold chunk_ids (e.g.
  // refusal / out_of_corpus) — there is no gold chunk whose recall we could echo.
  gold_in_pool?: boolean;
  gold_rank_bm25?: number | null;
  gold_rank_vector?: number | null;
  pool_size?: number;
  /** Per-gold-id table + per-arm rank breakdown (auditability). */
  gold_pool_detail?: GoldRankDetail[];
  /** Set only if the vector arm degraded (e.g. embed endpoint down); the pool
   *  columns then reflect the BM25 arm only, never silently read as a miss. */
  pool_echo_vector_error?: string;
}

// ---------------------------------------------------------------------------
// Tolerant answer-text matching (deterministic, no LLM)
// ---------------------------------------------------------------------------
//
// `answer_contains` / `answer_not_contains` used to be raw, case-sensitive
// substring matches. That mis-scored correct answers whenever the LLM
// paraphrased or reformatted — the confirmed real case being adversarial-001,
// where the pipeline cited the correct chunk but wrote "state law permits the
// imposition of a franchise fee" while the criterion asked for "...allows...".
//
// This layer loosens ONLY the answer-text checks. It normalizes case,
// whitespace, and punctuation, canonicalizes a small set of legal-deontic
// synonyms (allow/permit/authorize, prohibit/forbid/ban, require/mandate), and
// then accepts either a contiguous token-run match (order-preserving, precise)
// or a high content-token-coverage match (order-independent, for minor
// reordering/insertion). It never calls an LLM and is O(n) in answer length.
//
// HARD CONSTRAINT (owner decision, non-negotiable): the `cites_chunk` check
// stays an EXACT chunk_id string match — see evaluateCriterion. Only the
// free-text answer checks are loosened here.

/**
 * Small, deliberately conservative synonym groups. Each group lists common
 * inflections that map to a single canonical token. Scope is limited to the
 * legal-deontic operators that actually paraphrase in these answers; broad or
 * ambiguous synonyms are intentionally excluded to keep matching tight.
 */
export const ANSWER_MATCH_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  // permission — the confirmed adversarial-001 case (allows -> permits)
  [
    "allow",
    "allows",
    "allowed",
    "allowing",
    "permit",
    "permits",
    "permitted",
    "permitting",
    "authorize",
    "authorizes",
    "authorized",
    "authorizing",
    "authorise",
    "authorises",
    "authorised",
    "authorising",
  ],
  // prohibition
  [
    "prohibit",
    "prohibits",
    "prohibited",
    "prohibiting",
    "forbid",
    "forbids",
    "forbidden",
    "forbidding",
    "ban",
    "bans",
    "banned",
    "banning",
    "disallow",
    "disallows",
    "disallowed",
    "disallowing",
  ],
  // requirement
  [
    "require",
    "requires",
    "required",
    "requiring",
    "mandate",
    "mandates",
    "mandated",
    "mandating",
    "oblige",
    "obliges",
    "obliged",
    "obligating",
  ],
];

/** token -> canonical (first element of its group) */
const SYNONYM_CANON: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const group of ANSWER_MATCH_SYNONYM_GROUPS) {
    const canonical = group[0];
    for (const token of group) map.set(token, canonical);
  }
  return map;
})();

/** English function words dropped from the content-coverage fallback only. */
const MATCH_STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "for",
  "and",
  "or",
  "is",
  "are",
  "be",
  "that",
  "this",
  "it",
  "as",
  "at",
  "by",
  "with",
  "from",
]);

/** Fraction of content tokens that must be present for the fallback to pass. */
export const ANSWER_MATCH_COVERAGE_THRESHOLD = 0.8;

/**
 * Lowercase, strip punctuation to spaces, split into tokens, and canonicalize
 * synonyms. Returns the canonical token sequence.
 */
export function normalizeAnswerText(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => SYNONYM_CANON.get(t) ?? t);
}

/** True if `needle` appears as a contiguous run of tokens inside `haystack`. */
function isContiguousTokenMatch(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  outer:
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Tolerant replacement for `answer.includes(substring)`. Normalizes both sides,
 * then accepts a contiguous token-run match OR a content-token-coverage match
 * at/above ANSWER_MATCH_COVERAGE_THRESHOLD. Deterministic; no LLM.
 */
export function tolerantContains(answer: string, substring: string): boolean {
  const needle = normalizeAnswerText(substring);
  if (needle.length === 0) return true; // parity with "".includes semantics
  const haystack = normalizeAnswerText(answer);

  // 1) Precise, order-preserving match (survives case/whitespace/punctuation
  //    differences and single-word synonym swaps like allows -> permits).
  if (isContiguousTokenMatch(haystack, needle)) return true;

  // 2) Looser, order-independent fallback: every meaningful (non-stopword)
  //    token of the target — or its synonym — must appear, up to a small
  //    tolerance for dropped/reordered words.
  const content = needle.filter((t) => !MATCH_STOPWORDS.has(t));
  const target = content.length > 0 ? content : needle;
  const haystackSet = new Set(haystack);
  let present = 0;
  for (const t of target) {
    if (haystackSet.has(t)) present++;
  }
  return present / target.length >= ANSWER_MATCH_COVERAGE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Refusal detection
// ---------------------------------------------------------------------------

// The first five patterns catch outright refusals ("not in the documents",
// "I cannot find…"). The last two — added by the measurement fix — catch
// PARTIAL / hedged refusals: answers that decline the specific question up
// front and then add tangential neighbour facts, e.g.
//   "The provided documents do not state the mandatory minimum sentences… However…"
//   "Based on the provided documents, there is no mention of a budget surplus…"
// The original patterns scored these as non-refusals; the Fable full-system
// audit predicted this exact undercount verbatim.
//
// The partial-refusal patterns are ANCHORED to the START of the answer (after
// an optional "Based on/According to the provided documents," lead-in). This is
// deliberate: a genuine answer whose decline clause is *secondary* — e.g.
//   "Yes, every dealer is required to secure a permit […]. The provided
//    documents do not mention any exemptions for dealers."
// — LEADS with a substantive assertion and must NOT be reclassified as a
// refusal. Anchoring also keeps false assertions (e.g. the stale-officeholder
// "Sharon Bulova is listed as the supervisor…") classified as ASSERTIONS, so
// they stay in the correctness bucket where the project's policy wants them.
// Verified against every answer in the post-remediation results file: catches
// the five audit-named partial refusals, and misclassifies none of the eight
// genuine assertions checked (Dillon Rule, Fair Housing, Clean Water, Bulova,
// fence, two shared-mobility, retrieval-003).
export const REFUSAL_PATTERNS: readonly RegExp[] = [
  /i (don't|do not|cannot|can't) (find|have|know|answer)/i,
  /not (in|part of) (my|the) (corpus|knowledge|documents)/i,
  /no information (available|found)/i,
  /unable to (find|answer|provide)/i,
  /outside (the scope|my knowledge)/i,
  // Partial refusal — leads with "…documents do not state/specify/contain/… X".
  /^\s*(?:(?:based on|according to|per|within|in)\s+(?:the\s+)?(?:provided\s+|available\s+|supplied\s+|given\s+)?documents?,?\s+)?(?:the\s+)?(?:provided\s+|available\s+|supplied\s+|given\s+)?documents?\s+(?:do|does)\s+not\s+(?:state|specify|contain|mention|include|address|provide|indicate|list|define|discuss|cover|detail|reference|describe|identify|note|say)\b/i,
  // Partial refusal — leads with "…there is no mention/information/… of X".
  /^\s*(?:(?:based on|according to|per|within|in)\s+(?:the\s+)?(?:provided\s+|available\s+)?documents?,?\s+)?there\s+is\s+no\s+(?:mention|information|reference|indication|record|data)\b/i,
];

export function isRefusalAnswer(answer: string): boolean {
  if (!answer || answer.trim().length === 0) return true;
  return REFUSAL_PATTERNS.some((p) => p.test(answer));
}

// ---------------------------------------------------------------------------
// Correctness-vs-availability split metric (measurement fix)
// ---------------------------------------------------------------------------
//
// A single pass rate conflates two OPPOSITE failure modes that this project
// weights very differently under its stated correctness-over-availability
// policy:
//   • a FALSE ASSERTION (answered, but wrong or miscited) — never acceptable;
//   • a REFUSAL on an answerable question (declined / fell through) — the
//     cheaper, tolerated failure.
// These functions and computeSummaryMetrics are pure and exported so the real
// shipping split can be unit-tested (and mutation-probed) directly.

/**
 * A case "expects an answer" unless it explicitly expects a refusal (has an
 * `is_refusal` criterion). Refusal / out_of_corpus cases expect a refusal;
 * every other category expects a substantive answer.
 */
export function caseExpectsAnswer(criteria: readonly EvalCriterion[]): boolean {
  return !criteria.some((c) => c.check.type === "is_refusal");
}

export interface EvalSummaryMetrics {
  total: number;
  skipped: number;
  errored: number;
  ran: number;
  passed: number;
  overallPct: number | null;
  correctness: {
    asserted: number; // ran cases where the system asserted an answer
    correct: number; // …of those, how many fully passed (right & cited)
    pct: number | null;
    falseAssertionsWhereRefusalExpected: number; // severest sub-class
  };
  availability: {
    expected: number; // ran cases where an answer was expected
    answered: number; // …of those, how many the system actually answered
    refused: number; // …of those, how many it refused / fell through
    answeredPct: number | null;
    refusedPct: number | null;
  };
}

/**
 * Compute the overall rate PLUS the correctness/availability split from a set
 * of per-case results. Only cases that actually ran (pass/fail) count toward
 * the split; skipped and errored cases are reported separately and never
 * silently folded into a denominator.
 */
export function computeSummaryMetrics(
  results: readonly CaseResult[],
): EvalSummaryMetrics {
  const total = results.length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errored = results.filter((r) => r.status === "error").length;
  const runResults = results.filter(
    (r) => r.status === "pass" || r.status === "fail",
  );
  const ran = runResults.length;
  const passed = runResults.filter((r) => r.status === "pass").length;

  // Correctness: among cases where the system ASSERTED (did not refuse), how
  // many were fully correct. Every miss here is a false or miscited assertion.
  const asserted = runResults.filter((r) => r.refused === false);
  const correct = asserted.filter((r) => r.status === "pass").length;
  const falseAssertionsWhereRefusalExpected = asserted.filter(
    (r) => r.expects_answer === false,
  ).length;

  // Availability: among cases where an answer was EXPECTED, how often the
  // system refused / fell through.
  const expected = runResults.filter((r) => r.expects_answer === true);
  const refusedExpected = expected.filter((r) => r.refused === true).length;
  const answeredExpected = expected.length - refusedExpected;

  const pct = (num: number, den: number): number | null =>
    den > 0 ? Math.round((num / den) * 100) : null;

  return {
    total,
    skipped,
    errored,
    ran,
    passed,
    overallPct: pct(passed, ran),
    correctness: {
      asserted: asserted.length,
      correct,
      pct: pct(correct, asserted.length),
      falseAssertionsWhereRefusalExpected,
    },
    availability: {
      expected: expected.length,
      answered: answeredExpected,
      refused: refusedExpected,
      answeredPct: pct(answeredExpected, expected.length),
      refusedPct: pct(refusedExpected, expected.length),
    },
  };
}

// ---------------------------------------------------------------------------
// Criterion evaluation (deterministic, no LLM)
// ---------------------------------------------------------------------------

export function evaluateCriterion(
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
      // EXACT match, by owner decision — this is how the spec's cite-exact-chunk
      // bar is measured. Do NOT loosen.
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
      pass = tolerantContains(answer, check.substring);
      if (!pass) note = `Answer does not contain (even tolerantly) "${check.substring}"`;
      break;
    }

    case "answer_not_contains": {
      pass = !tolerantContains(answer, check.substring);
      if (!pass) note = `Answer unexpectedly contains (tolerantly) "${check.substring}"`;
      break;
    }

    default:
      note = `Unknown check type: ${(check as { type: string }).type}`;
      pass = false;
  }

  return { criterion_id: criterion.id, pass, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------
// Live runner — guarded so importing this module has no side effects.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // -------------------------------------------------------------------------
  // CLI flags
  // -------------------------------------------------------------------------

  // NOTE: std/flags `parse` has no `number` option (it was previously passed
  // and silently ignored — this module was never in a type-checked graph until
  // the grading tests imported it). Numeric flags are coerced explicitly below.
  const args = parse(Deno.args, {
    string: ["category", "cases-dir", "results-dir", "batch-size", "batch-delay"],
    default: {
      "batch-size": "20",
      "batch-delay": "30000",
      "cases-dir": "eval/cases",
      "results-dir": "eval/results",
    },
  });

  const CATEGORY_FILTER = args["category"] as string | undefined;
  const BATCH_SIZE = Number(args["batch-size"]);
  const BATCH_DELAY = Number(args["batch-delay"]);
  const CASES_DIR = args["cases-dir"] as string;
  const RESULTS_DIR = args["results-dir"] as string;

  // -------------------------------------------------------------------------
  // Env vars
  // -------------------------------------------------------------------------

  const requireEnv = (name: string): string => {
    const val = Deno.env.get(name);
    if (!val) throw new Error(`Missing required env var: ${name}`);
    return val;
  };

  const QUERY_PIPELINE_URL = requireEnv("QUERY_PIPELINE_URL");
  const SUPABASE_ANON_KEY = requireEnv("SUPABASE_ANON_KEY");
  const SUPABASE_URL = requireEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  // Optional: docling-wrapper /embed base URL (thenlper/gte-small, same model as
  // the pipeline's Supabase.ai.Session). Used ONLY by the additive pool-echo
  // instrumentation to reconstruct the vector retrieval arm. If unset, pool echo
  // still records the BM25 arm; the vector columns are null with an error note.
  const EMBED_URL = Deno.env.get("HF_SPACES_DOCLING_URL") ??
    Deno.env.get("EMBED_URL");

  // -------------------------------------------------------------------------
  // Load cases
  // -------------------------------------------------------------------------

  const loadCases = async (): Promise<EvalCase[]> => {
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
  };

  // -------------------------------------------------------------------------
  // Pre-run chunk ID verification
  // -------------------------------------------------------------------------

  const CHUNK_TABLES = [
    "narrative_chunks",
    "vote_tallies",
    "policy_decisions",
    "budget_indicators",
    "ordinance_provisions",
  ] as const;

  const verifyChunkIds = async (cases: EvalCase[]): Promise<Set<string>> => {
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
        console.error(
          `WARN: Could not query ${table} for chunk verification: ${error.message}`,
        );
        continue;
      }
      for (const row of data ?? []) {
        foundIds.add(row.id as string);
      }
    }

    return foundIds;
  };

  // -------------------------------------------------------------------------
  // Pipeline call
  // -------------------------------------------------------------------------

  const callPipeline = async (
    query: string,
  ): Promise<{ data: unknown; ms: number }> => {
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
  };

  // -------------------------------------------------------------------------
  // Sleep with countdown
  // -------------------------------------------------------------------------

  const sleepWithCountdown = async (ms: number): Promise<void> => {
    const seconds = Math.ceil(ms / 1000);
    for (let remaining = seconds; remaining > 0; remaining--) {
      await Deno.stdout.write(
        new TextEncoder().encode(`\r  Batch cooldown: ${remaining}s remaining...`),
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log();
  };

  // -------------------------------------------------------------------------
  // Summary printing
  // -------------------------------------------------------------------------

  const printSummary = (results: CaseResult[], resultsPath: string): void => {
    const m = computeSummaryMetrics(results);
    const fmtPct = (p: number | null): string => (p === null ? "n/a" : `${p}%`);

    console.log("\n=== EVAL SUMMARY ===");
    console.log(`Total cases:   ${m.total}`);
    console.log(`Skipped:       ${m.skipped}  (missing chunk_ids)`);
    console.log(`Errored:       ${m.errored}  (pipeline call failures)`);
    console.log(`Ran:           ${m.ran}`);

    if (m.ran > 0) {
      console.log("\nBy category:");
      const categories = [
        ...new Set(
          results
            .filter((r) => r.status === "pass" || r.status === "fail")
            .map((r) => r.category),
        ),
      ].sort();

      for (const cat of categories) {
        const catResults = results.filter(
          (r) => r.category === cat && (r.status === "pass" || r.status === "fail"),
        );
        const catPassed = catResults.filter((r) => r.status === "pass").length;
        const pct = Math.round((catPassed / catResults.length) * 100);
        const label = `${cat}:`.padEnd(40);
        console.log(`  ${label} ${catPassed}/${catResults.length} passed (${pct}%)`);
      }

      // Overall rate kept verbatim for continuity with prior runs — but it is
      // NOT the headline any more, because it conflates two opposite failures.
      console.log(
        `\nOverall pass rate (continuity): ${fmtPct(m.overallPct)} (${m.passed}/${m.ran} ran)`,
      );

      // -----------------------------------------------------------------------
      // The split that actually matters under this project's stated policy:
      // a FALSE ASSERTION is far worse than a REFUSAL on an answerable question.
      // -----------------------------------------------------------------------
      const c = m.correctness;
      const a = m.availability;
      console.log("\n=== CORRECTNESS vs AVAILABILITY ===");
      console.log(
        "  (policy: a false/miscited assertion is far worse than a refusal on an answerable question)",
      );
      console.log(
        `\n  CORRECTNESS  ${
          fmtPct(c.pct)
        }  (${c.correct}/${c.asserted} of ASSERTED answers were right & correctly cited)`,
      );
      console.log(
        `    -> ${
          c.asserted - c.correct
        } assertion(s) were WRONG or MISCITED  <-- the severe failure class (target: 0)`,
      );
      console.log(
        `    -> of those, ${c.falseAssertionsWhereRefusalExpected} asserted where a REFUSAL was expected (false-premise assertions)`,
      );
      console.log(
        `\n  AVAILABILITY  answered ${
          fmtPct(a.answeredPct)
        } (${a.answered}/${a.expected}) of ANSWERABLE cases`,
      );
      console.log(
        `    -> refused/fell through on ${a.refused}/${a.expected} (${
          fmtPct(a.refusedPct)
        })  <-- the cheaper failure under this policy`,
      );
    }

    console.log(`\nResults written to: ${resultsPath}`);
  };

  // -------------------------------------------------------------------------
  // Main
  // -------------------------------------------------------------------------

  const main = async (): Promise<void> => {
    // Validate category flag
    if (CATEGORY_FILTER) {
      const validCategories = Object.values(EvalCategory) as string[];
      if (!validCategories.includes(CATEGORY_FILTER)) {
        console.error(
          `ERROR: Unknown category "${CATEGORY_FILTER}". Valid categories:\n  ${
            validCategories.join("\n  ")
          }`,
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
        console.log(
          `WARN: chunk_id ${id} (case ${c.id}) not found in any chunk table — case will be skipped`,
        );
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
      expects_answer: caseExpectsAnswer(c.criteria),
    }));

    // Durable per-case artifact (measurement fix): the results path is fixed up
    // front and REWRITTEN after every case, so a crash, rate-limit blowup, or
    // Ctrl-C can never again leave a run with no durable per-case evidence (the
    // 2026-07-22 baseline's per-case results were lost exactly this way). The
    // written file includes the split-metric summary so it is self-describing.
    await Deno.mkdir(RESULTS_DIR, { recursive: true });
    const runStartedAt = new Date().toISOString();
    const resultsPath = join(RESULTS_DIR, `${runStartedAt.replace(/[:.]/g, "-")}.json`);
    const flushResults = async (): Promise<void> => {
      await Deno.writeTextFile(
        resultsPath,
        JSON.stringify(
          {
            timestamp: runStartedAt,
            completed_at: new Date().toISOString(),
            summary: computeSummaryMetrics(results),
            results,
          },
          null,
          2,
        ),
      );
    };
    // Write once immediately so the artifact exists even if batch 1 dies early.
    await flushResults();

    // Retrieval-pool instrumentation client (service role; reads chunk tables via
    // the same bm25_/match_ RPCs the pipeline calls). Kept entirely separate from
    // the pipeline call — it never influences grading, only annotates results.
    const poolClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const attachPoolEcho = async (
      caseResult: CaseResult,
      evalCase: EvalCase,
    ): Promise<void> => {
      // No gold chunk → nothing whose pool recall we could echo (refusal /
      // out_of_corpus). Leave the columns undefined.
      if (evalCase.chunk_ids.length === 0) return;
      try {
        const echo = await computeCasePoolEcho(
          poolClient,
          evalCase.query,
          evalCase.chunk_ids,
          { embedUrl: EMBED_URL },
        );
        caseResult.gold_in_pool = echo.gold_in_pool;
        caseResult.gold_rank_bm25 = echo.gold_rank_bm25;
        caseResult.gold_rank_vector = echo.gold_rank_vector;
        caseResult.pool_size = echo.pool_size;
        caseResult.gold_pool_detail = echo.gold_detail;
        if (echo.vector_arm_error) {
          caseResult.pool_echo_vector_error = echo.vector_arm_error;
        }
      } catch (err) {
        // Instrumentation must never fail a run; record the reason and move on.
        caseResult.pool_echo_vector_error = `pool echo failed: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    };

    // Execute in batches
    const batches: EvalCase[][] = [];
    for (let i = 0; i < runnableCases.length; i += BATCH_SIZE) {
      batches.push(runnableCases.slice(i, i + BATCH_SIZE));
    }

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      console.log(`Batch ${batchIdx + 1}/${batches.length} — ${batch.length} case(s)`);

      for (const evalCase of batch) {
        await Deno.stdout.write(
          new TextEncoder().encode(`  [${evalCase.id}] ${evalCase.category} — `),
        );

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
              expects_answer: caseExpectsAnswer(evalCase.criteria),
            };
            console.log(`ERROR — ${caseResult.error_message}`);
          } else {
            const responseData = env.data;
            const answer: string = responseData?.answer ?? "";
            const citedChunkIds: string[] = (responseData?.citations ?? []).map(
              (c: { chunk_id: string }) => c.chunk_id,
            );
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
              answer,
              cited_chunk_ids: citedChunkIds,
              expects_answer: caseExpectsAnswer(evalCase.criteria),
              refused: isRefusalAnswer(answer),
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
            expects_answer: caseExpectsAnswer(evalCase.criteria),
          };
          console.log(`ERROR — ${caseResult.error_message}`);
        }

        // Additive retrieval-pool annotation (independent of the pipeline call;
        // never touches status/criteria). Computed here so it is checkpointed
        // with the case.
        await attachPoolEcho(caseResult, evalCase);

        results.push(caseResult);
        // Checkpoint after EVERY case: at most the in-flight case is ever lost.
        await flushResults();
      }

      // Pause between batches (not after the last one)
      if (batchIdx < batches.length - 1) {
        console.log(
          `\nBatch ${batchIdx + 1} complete. Waiting ${BATCH_DELAY}ms before next batch...`,
        );
        await sleepWithCountdown(BATCH_DELAY);
      }
    }

    // Final write (identical content to the last checkpoint, plus a fresh
    // completed_at) and the summary.
    await flushResults();
    printSummary(results, resultsPath);
  };

  main().catch((err) => {
    console.error("FATAL:", err instanceof Error ? err.message : err);
    Deno.exit(1);
  });
}
