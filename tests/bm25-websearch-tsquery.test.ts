/**
 * Static-source-inspection tests for the BM25 RPC query-construction fix
 * (supabase/migrations/20260722150000_bm25_websearch_tsquery.sql).
 * CI does not have a live Supabase instance, so these tests guard the
 * migration-level function definitions against reverting to plainto_tsquery's
 * AND semantics for multi-word natural-language queries.
 */

const MIGRATION_PATH = "supabase/migrations/20260722150000_bm25_websearch_tsquery.sql";

const BM25_FUNCTIONS = [
  "bm25_ordinance_provisions",
  "bm25_vote_tallies",
  "bm25_policy_decisions",
  "bm25_budget_indicators",
  "bm25_narrative_chunks",
] as const;
const OR_WEBSEARCH_TSQUERY =
  "websearch_to_tsquery('english', regexp_replace(trim(p_query_text), '[[:space:]]+', ' OR ', 'g'))";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readMigration(): Promise<string> {
  return await Deno.readTextFile(MIGRATION_PATH);
}

Deno.test({
  name: "BM25 RPCs use websearch_to_tsquery with the english dictionary",
  permissions: { read: [MIGRATION_PATH] },
  fn: async () => {
    const sql = await readMigration();

    for (const fn of BM25_FUNCTIONS) {
      const fnStart = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}`);
      assert(fnStart >= 0, `expected ${fn} to be redefined`);

      const nextFnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.", fnStart + 1);
      const body = sql.slice(fnStart, nextFnStart === -1 ? undefined : nextFnStart);

      assert(
        !body.includes("plainto_tsquery"),
        `expected ${fn} body not to use plainto_tsquery`,
      );
      assert(
        body.includes(OR_WEBSEARCH_TSQUERY),
        `expected ${fn} to build tsqueries with explicit web-search OR operators`,
      );
      assert(
        body.includes(`WHERE content_tsv @@ ${OR_WEBSEARCH_TSQUERY}`),
        `expected ${fn} WHERE clause to use websearch_to_tsquery`,
      );
      assert(
        body.includes(`ORDER BY ts_rank(content_tsv, ${OR_WEBSEARCH_TSQUERY}) DESC`),
        `expected ${fn} ranking to use the same websearch tsquery`,
      );
    }
  },
});

Deno.test({
  name: "BM25 RPC signatures, service_role grants, ranking, and default limit are preserved",
  permissions: { read: [MIGRATION_PATH] },
  fn: async () => {
    const sql = await readMigration();

    for (const fn of BM25_FUNCTIONS) {
      const fnStart = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}`);
      const nextFnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.", fnStart + 1);
      const body = sql.slice(fnStart, nextFnStart === -1 ? undefined : nextFnStart);

      assert(
        body.includes("p_limit      int DEFAULT 40"),
        `expected ${fn} to preserve p_limit default 40`,
      );
      assert(
        body.includes("LANGUAGE sql STABLE SECURITY DEFINER"),
        `expected ${fn} to preserve language/volatility/security attributes`,
      );
      assert(body.includes("LIMIT p_limit"), `expected ${fn} to preserve LIMIT p_limit`);
      assert(
        body.includes(`GRANT EXECUTE ON FUNCTION public.${fn}(text, int) TO service_role`),
        `expected ${fn} execute grant to service_role`,
      );
    }
  },
});
