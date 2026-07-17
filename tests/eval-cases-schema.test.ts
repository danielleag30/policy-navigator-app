/**
 * Structural validation for eval/cases/*.json against eval/schema.ts's
 * EvalCase/EvalCriterion/CriterionCheck shapes. No live pipeline or DB access
 * (matches this repo's existing static-source-inspection convention -- see
 * tests/encode-ingestion.test.ts's file header -- since no live Supabase
 * instance is available in CI). This is a general regression guard for the
 * whole suite, not scoped to any one PR's cases.
 *
 * Also guards the specific false-fail bug found and fixed across PR #90/#96/
 * #99/#100: eval/runner.ts's `answer_not_contains` check is a raw substring
 * match with no negation-awareness, so it wrongly fails a correct answer that
 * legitimately mentions the old/wrong term in order to negate it. No case in
 * this suite should use that check type going forward.
 */

import { EvalCategory } from "../eval/schema.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const VALID_CATEGORIES = new Set(Object.values(EvalCategory));
const VALID_CHECK_TYPES = new Set([
  "not_refusal",
  "is_refusal",
  "cites_chunk",
  "temporal_flag",
  "no_temporal_flag",
  "answer_contains",
  "answer_not_contains",
]);

interface LoadedCase {
  file: string;
  id: unknown;
  category: unknown;
  query: unknown;
  chunk_ids: unknown;
  criteria: unknown;
  notes?: unknown;
}

async function loadAllCases(): Promise<LoadedCase[]> {
  const cases: LoadedCase[] = [];
  for await (const entry of Deno.readDir("eval/cases")) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const raw = await Deno.readTextFile(`eval/cases/${entry.name}`);
    const parsed = JSON.parse(raw);
    assert(
      Array.isArray(parsed),
      `${entry.name} must contain a JSON array of cases`,
    );
    for (const c of parsed) {
      cases.push({ file: entry.name, ...c });
    }
  }
  return cases;
}

Deno.test("every eval case has the required EvalCase fields with correct types", async () => {
  const cases = await loadAllCases();
  assert(cases.length > 0, "expected at least one eval case to be loaded");

  for (const c of cases) {
    assert(
      typeof c.id === "string" && c.id.length > 0,
      `${c.file}: case id must be a non-empty string`,
    );
    assert(
      VALID_CATEGORIES.has(c.category as EvalCategory),
      `${c.file}/${c.id}: category "${c.category}" is not a valid EvalCategory`,
    );
    assert(
      typeof c.query === "string" && c.query.length > 0,
      `${c.file}/${c.id}: query must be a non-empty string`,
    );
    assert(
      Array.isArray(c.chunk_ids),
      `${c.file}/${c.id}: chunk_ids must be an array`,
    );
    assert(
      Array.isArray(c.criteria) && c.criteria.length > 0,
      `${c.file}/${c.id}: criteria must be a non-empty array`,
    );
  }
});

Deno.test("every criterion has a valid check type and required check fields", async () => {
  const cases = await loadAllCases();

  for (const c of cases) {
    const criteria = c.criteria as Array<
      { id: unknown; description: unknown; check: { type: unknown } }
    >;
    for (const criterion of criteria) {
      assert(
        typeof criterion.id === "string" && criterion.id.length > 0,
        `${c.file}/${c.id}: criterion id must be a non-empty string`,
      );
      assert(
        typeof criterion.description === "string" &&
          criterion.description.length > 0,
        `${c.file}/${c.id}/${criterion.id}: description must be a non-empty string`,
      );
      const check = criterion.check as Record<string, unknown>;
      assert(
        VALID_CHECK_TYPES.has(check.type as string),
        `${c.file}/${c.id}/${criterion.id}: unknown check type "${check.type}"`,
      );
      if (check.type === "cites_chunk") {
        assert(
          typeof check.chunk_id === "string" && check.chunk_id.length > 0,
          `${c.file}/${c.id}/${criterion.id}: cites_chunk requires a non-empty chunk_id`,
        );
      }
      if (check.type === "answer_contains" || check.type === "answer_not_contains") {
        assert(
          typeof check.substring === "string" && check.substring.length > 0,
          `${c.file}/${c.id}/${criterion.id}: ${check.type} requires a non-empty substring`,
        );
      }
    }
  }
});

Deno.test("no eval case uses the false-fail-prone answer_not_contains check (PR #90/#96/#99/#100 regression guard)", async () => {
  const cases = await loadAllCases();

  for (const c of cases) {
    const criteria = c.criteria as Array<{ check: { type: unknown } }>;
    for (const criterion of criteria) {
      assert(
        criterion.check.type !== "answer_not_contains",
        `${c.file}/${c.id}: uses answer_not_contains, which false-fails a correct answer that ` +
          `legitimately mentions the negated term (e.g. "No, it's not X -- it's Y"). Use ` +
          `answer_contains/cites_chunk on the correct answer instead.`,
      );
    }
  }
});

Deno.test("no duplicate case ids across the whole eval suite", async () => {
  const cases = await loadAllCases();
  const seen = new Map<string, string>();

  for (const c of cases) {
    const id = c.id as string;
    const prevFile = seen.get(id);
    assert(
      !prevFile,
      `duplicate case id "${id}" found in both ${prevFile} and ${c.file}`,
    );
    seen.set(id, c.file);
  }
});

Deno.test("the 3 new EnCode zoning historical-backfill cases (temporal-013/014, adversarial-015) are present and well-formed", async () => {
  const cases = await loadAllCases();
  const byId = new Map(cases.map((c) => [c.id as string, c]));

  const adu = byId.get("temporal-013");
  const homeBased = byId.get("temporal-014");
  const trap = byId.get("adversarial-015");

  assert(adu !== undefined, "temporal-013 (ADU) is missing");
  assert(homeBased !== undefined, "temporal-014 (Home-Based Business) is missing");
  assert(trap !== undefined, "adversarial-015 (ADU continuity trap) is missing");

  const CURRENT_CHUNK = "019f4c4c-7368-74e9-9e28-946612b06d8b";
  for (const c of [adu, homeBased, trap]) {
    assert(
      (c!.chunk_ids as string[]).includes(CURRENT_CHUNK),
      `${c!.id}: expected to cite the current Accessory Uses chunk ${CURRENT_CHUNK}`,
    );
  }
});
