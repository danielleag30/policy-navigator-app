/**
 * Static guards for the BM25 OR-semantics rework migration
 * (supabase/migrations/20260723160000_bm25_or_semantics_rework.sql).
 *
 * These are structural assertions over the migration text — they do not hit the
 * database. They lock in the three invariants this rework must hold across all five
 * bm25_* functions, so a future edit that regresses any of them fails CI:
 *
 *   1. OR semantics: the tsquery is built by flipping plainto_tsquery's `&` connective
 *      to `|`. This is the measured recall fix (see migration header). Guards against a
 *      silent revert to plainto_tsquery (AND), which returned 0 rows on 56% of the
 *      156-question eval set.
 *   2. Superseded-row exclusion preserved: every function keeps the `JOIN documents`
 *      + `status != 'superseded'` filter that is live in pg_proc but absent from the
 *      source migration 20260621000001. The superseded PR #126 dropped this join; this
 *      test ensures the replacement never does.
 *   3. english dictionary + LIMIT p_limit + STABLE SECURITY DEFINER retained.
 */

const MIGRATION_PATH = "supabase/migrations/20260723160000_bm25_or_semantics_rework.sql";

const BM25_FUNCTIONS = [
  "bm25_ordinance_provisions",
  "bm25_vote_tallies",
  "bm25_policy_decisions",
  "bm25_budget_indicators",
  "bm25_narrative_chunks",
] as const;

// The exact OR-injection expression the rework installs.
const OR_TSQUERY = "replace(plainto_tsquery('english', p_query_text)::text, '&', '|')::tsquery";

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

function bodyOf(sql: string, fn: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  assert(start >= 0, `migration missing CREATE OR REPLACE FUNCTION public.${fn}`);
  // Body ends at the next function definition or end-of-file.
  const nextFn = sql.indexOf("CREATE OR REPLACE FUNCTION public.", start + 1);
  return sql.slice(start, nextFn === -1 ? undefined : nextFn);
}

Deno.test("BM25 rework: all five functions use OR-injected tsquery (not plainto AND)", async () => {
  const sql = await Deno.readTextFile(MIGRATION_PATH);
  for (const fn of BM25_FUNCTIONS) {
    const body = bodyOf(sql, fn);
    assert(
      body.includes(OR_TSQUERY),
      `${fn}: expected OR-injection expression ${OR_TSQUERY}`,
    );
    // The bare AND form must not survive in a WHERE/ORDER BY predicate.
    assert(
      !/content_tsv @@ plainto_tsquery/.test(body),
      `${fn}: WHERE clause still uses plainto_tsquery (AND) — recall regression`,
    );
  }
});

Deno.test("BM25 rework: all five functions preserve the superseded-row exclusion", async () => {
  const sql = await Deno.readTextFile(MIGRATION_PATH);
  for (const fn of BM25_FUNCTIONS) {
    const body = bodyOf(sql, fn);
    assert(
      /JOIN documents d ON d\.id = \w+\.document_id/.test(body),
      `${fn}: missing JOIN documents (superseded filter would be unenforceable)`,
    );
    assert(
      body.includes("d.status != 'superseded'"),
      `${fn}: missing status != 'superseded' filter`,
    );
  }
});

Deno.test("BM25 rework: english dictionary, LIMIT p_limit, and STABLE SECURITY DEFINER retained", async () => {
  const sql = await Deno.readTextFile(MIGRATION_PATH);
  for (const fn of BM25_FUNCTIONS) {
    const body = bodyOf(sql, fn);
    assert(
      body.includes("plainto_tsquery('english'"),
      `${fn}: english dictionary not used`,
    );
    assert(body.includes("LIMIT p_limit"), `${fn}: LIMIT p_limit dropped`);
    assert(
      /LANGUAGE sql STABLE SECURITY DEFINER/.test(body),
      `${fn}: STABLE SECURITY DEFINER changed`,
    );
  }
});

Deno.test("BM25 rework: re-asserts the S-1 lockdown (service_role only, no PUBLIC widening)", async () => {
  const sql = await Deno.readTextFile(MIGRATION_PATH);
  for (const fn of BM25_FUNCTIONS) {
    assert(
      sql.includes(
        `REVOKE EXECUTE ON FUNCTION public.${fn}(text, integer)`,
      ),
      `${fn}: missing REVOKE from PUBLIC/anon/authenticated`,
    );
    assert(
      sql.includes(`GRANT EXECUTE ON FUNCTION public.${fn}(text, integer)`),
      `${fn}: missing GRANT to service_role`,
    );
  }
});
