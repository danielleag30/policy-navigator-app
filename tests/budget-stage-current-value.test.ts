import { effectiveDateForBudgetIndicator } from "../supabase/functions/_shared/document-date.ts";
import { canonicalizeBudgetIndicatorName } from "../supabase/functions/_shared/budget-indicator.ts";

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
      migration.includes("LIKE '%/fy20%/adopted-package/%'"),
    "migration must classify real advertised/adopted budget URL shapes",
  );
  assert(
    migration.includes("make_date(bi.fiscal_year - 1, 7, 1)") &&
      migration.includes("effective_date_source"),
    "migration must backfill FY July 1 effective dates using amendment_events effective_date_source shape",
  );
});
