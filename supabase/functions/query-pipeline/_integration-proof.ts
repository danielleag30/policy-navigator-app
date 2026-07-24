/**
 * OFFLINE INTEGRATION PROOF — not a unit test (needs the live DB), so it is named
 * `_integration-proof.ts` and NOT `*_test.ts`, so `deno test` never picks it up.
 *
 * It exercises the REAL shipping resolver (resolveCurrentValueForQuery from
 * index.ts) against the live database for the five tax-rate subjects in the fix
 * brief. resolveCurrentValueForQuery runs the exact deterministic sequence the
 * Deno.serve handler runs (prefetch anchors via the live bm25_ordinance_provisions
 * RPC + full budget_indicators scan → supersession pre-filter → current-state
 * rerank → §5.2.1 narrative guard → deterministic winner), so this is the shipping
 * code path, not a reimplementation.
 *
 * Run (never prints secrets):
 *   deno run --allow-env --allow-net --allow-write --node-modules-dir=auto \
 *     --env-file=/Users/daniellegeorge/Projects/policy-navigator-app/.env.local \
 *     supabase/functions/query-pipeline/_integration-proof.ts [fixture-out.json]
 */
import {
  fetchSourceDocuments,
  prependCurrentBudgetIndicators,
  resolveCurrentValueForQuery,
  resolveDeterministicCurrentValue,
} from "./index.ts";

const SUBJECTS = [
  { subject: "real estate tax rate", expect: "budget_indicators $1.12" },
  { subject: "personal property tax rate", expect: "budget_indicators $4.57" },
  { subject: "transient occupancy tax rate", expect: "ordinance 6%" },
  { subject: "meals tax rate", expect: "correct-or-fall-through" },
  { subject: "cigarette tax rate", expect: "correct-or-fall-through" },
];

const naturalQuery = (subject: string) => `what is the current ${subject}`;

const rows: string[] = [];
const capturedFixtures: Record<string, unknown> = {
  _generated: "from live DB via _integration-proof.ts",
};

for (const { subject, expect } of SUBJECTS) {
  const query = naturalQuery(subject);
  const outcome = await resolveCurrentValueForQuery(query);

  const source = outcome.source ?? "FALL-THROUGH";
  const value = outcome.value ?? "—";
  const where = outcome.sectionTitle ?? outcome.sectionNodeId ?? "—";
  rows.push(
    [
      subject.padEnd(28),
      String(source).padEnd(20),
      String(value).padEnd(10),
      where,
    ].join(" | "),
  );
  console.error(
    `${subject} -> ${source} ${value} (${where}) [expect ${expect}]`,
  );

  // Capture the winning candidate + its document as a real-row fixture so the
  // offline unit test can assert the exact production ordering on real data.
  const anchored = await prependCurrentBudgetIndicators(query, []);
  const documents = await fetchSourceDocuments(anchored);
  const winner = resolveDeterministicCurrentValue(query, anchored, documents);
  if (winner) {
    const doc = typeof winner.row.document_id === "string"
      ? documents.get(winner.row.document_id) ?? null
      : null;
    const key = subject.replace(/[^a-z]+/g, "_");
    capturedFixtures[key] = {
      table: winner.table,
      row: winner.row,
      document: doc,
    };
  }
}

console.log("\n| subject | source | value | section |");
console.log("|---|---|---|---|");
for (const r of rows) {
  const [s, src, v, w] = r.split(" | ").map((x) => x.trim());
  console.log(`| ${s} | ${src} | ${v} | ${w} |`);
}

const outPath = Deno.args[0];
if (outPath) {
  await Deno.writeTextFile(
    outPath,
    JSON.stringify(capturedFixtures, null, 2) + "\n",
  );
  console.error(`\nwrote captured fixtures to ${outPath}`);
}
