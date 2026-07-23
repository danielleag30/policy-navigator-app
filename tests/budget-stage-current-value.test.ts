import { effectiveDateForBudgetIndicator } from "../supabase/functions/_shared/document-date.ts";
import {
  budgetIndicatorEmbeddingInput,
  canonicalizeBudgetIndicatorName,
} from "../supabase/functions/_shared/budget-indicator.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("budget_stage is declared for advertised and adopted budget seed sources", async () => {
  const raw = await Deno.readTextFile(
    new URL("../supabase/config/seed-sources.json", import.meta.url),
  );
  const config = JSON.parse(raw);
  const advertised = config.sources.find((s: { id: string }) => s.id === "budget_pdf_advertised");
  const adopted = config.sources.find((s: { id: string }) => s.id === "budget_pdf_adopted");

  assertEquals(advertised?.doc_type, "budget_pdf");
  assertEquals(advertised?.budget_stage, "advertised");
  assertEquals(adopted?.doc_type, "budget_pdf");
  assertEquals(adopted?.budget_stage, "adopted");
});

Deno.test("FY adopted budget indicators receive July 1 effective date", () => {
  assertEquals(effectiveDateForBudgetIndicator("adopted", 2027), {
    effectiveDate: "2026-07-01",
    effectiveDateSource: "default",
  });
  assertEquals(effectiveDateForBudgetIndicator("advertised", 2027), {
    effectiveDate: null,
    effectiveDateSource: null,
  });
});

Deno.test("tax-rate indicator names collapse stage-prefixed duplicates", () => {
  assertEquals(
    canonicalizeBudgetIndicatorName("adopted Real Estate Tax rate"),
    "Real Estate Tax rate",
  );
  assertEquals(
    canonicalizeBudgetIndicatorName("Advertised personal property tax rate"),
    "Personal Property Tax rate",
  );
});

Deno.test("budget indicator embedding input is structured and excludes source blob", () => {
  const rawBlob =
    "Real Estate Tax Base 2022 2023 2024 2025 2026 2027 Residential Equalization 4.25% 9.57% 6.97% 2.86% 6.17% 3.99%";
  const first = budgetIndicatorEmbeddingInput({
    fiscal_year: 2022,
    department: null,
    program: "Real Estate Tax Base",
    indicator_name: "Residential Equalization",
    value_actual: "4.2500",
    value_target: null,
    value_prior_year: null,
    unit: "percent",
    budget_stage: "advertised",
    effective_date: null,
    effective_date_source: null,
    chunk_sequence: 2,
  });
  const sibling = budgetIndicatorEmbeddingInput({
    fiscal_year: 2027,
    department: null,
    program: "Real Estate Tax Base",
    indicator_name: "Residential Equalization",
    value_actual: "3.9900",
    value_target: null,
    value_prior_year: "6.1700",
    unit: "percent",
    budget_stage: "advertised",
    effective_date: null,
    effective_date_source: null,
    chunk_sequence: 2,
  });

  assert(first !== sibling, "sibling indicator rows must not share embedding input");
  assert(
    first.includes("indicator_name: Residential Equalization"),
    "input should include indicator name",
  );
  assert(first.includes("fiscal_year: 2022"), "first row should include FY 2022");
  assert(sibling.includes("fiscal_year: 2027"), "sibling row should include FY 2027");
  assert(
    sibling.includes("value_prior_year: 6.1700"),
    "sibling row should include prior-year value",
  );
  assert(!first.includes(rawBlob), "embedding input must not include raw_extracted_text");
});

Deno.test("budget indicator embedding input can read budget_stage from joined document", () => {
  const input = budgetIndicatorEmbeddingInput({
    fiscal_year: 2027,
    indicator_name: "Average tax bill increase",
    value_actual: 357,
    unit: "dollars",
    documents: { budget_stage: "adopted" },
  });

  assert(input.includes("budget_stage: adopted"), "joined budget stage should be included");
  assert(input.includes("value_actual: 357"), "actual value should be included");
});

Deno.test("migration backfills budget_stage and effective date from real URL patterns", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "../supabase/migrations/20260722120000_budget_stage_and_indicator_effective_dates.sql",
      import.meta.url,
    ),
  );
  assert(
    migration.includes("LIKE '%/fy20%/advertised/%'") &&
      migration.includes("LIKE '%/fy20%/adopted/%'") &&
      migration.includes("LIKE '%/fy20%/adopted-package/%'") &&
      migration.includes("LIKE '%/fy20%/fy20%-adopted-package.pdf'"),
    "migration must classify real advertised/adopted budget URL shapes",
  );
  assert(
    migration.includes("make_date(bi.fiscal_year - 1, 7, 1)") &&
      migration.includes("effective_date_source"),
    "migration must backfill FY July 1 effective dates using amendment_events effective_date_source shape",
  );
});

Deno.test("ingest orchestrator embeds budget indicators from structured formatter", async () => {
  const src = await Deno.readTextFile(
    new URL("../supabase/functions/ingest-orchestrator/index.ts", import.meta.url),
  );

  assert(
    src.includes("budgetIndicatorEmbeddingInput"),
    "ingest path must use the shared structured budget indicator embedding formatter",
  );
  assert(
    src.includes('select("budget_stage")') &&
      src.includes("value_actual, value_target, value_prior_year") &&
      src.includes("const texts = rows.map((r) =>") &&
      src.includes("budgetIndicatorEmbeddingInput({"),
    "ingest path must fetch structured budget indicator columns and not embed raw_extracted_text",
  );
});

Deno.test("re-embed job is held-safe and uses structured formatter", async () => {
  const src = await Deno.readTextFile(
    new URL("../scripts/reembed-budget-indicators.ts", import.meta.url),
  );

  assert(
    src.includes("BUDGET_INDICATOR_REEMBED_WRITE") && src.includes("dry-run"),
    "job should default to dry-run unless write is explicitly enabled",
  );
  assert(src.includes("START_AFTER_ID"), "job should expose cursor resume");
  assert(src.includes("REEMBED_DEADLINE_MS"), "job should expose a deadline");
  assert(src.includes("budgetIndicatorEmbeddingInput"), "job should use shared formatter");
  assert(src.includes("generateEmbeddingsHttpBatched"), "job should use HTTP embed path");
});
