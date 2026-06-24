// AC4 verification for task 0-8: confirms the shared db-client initialises and
// can reach the live Supabase project (ahaurkifxzqsrhwjshbj).
//
// The `documents` table does not exist yet (Phase 1 creates it). A 404 / PGRST
// "relation does not exist" response from PostgREST is a PASS — it proves the
// client authenticated and the project is reachable. An auth error or network
// failure is a FAIL.
//
// Run with:
//   cd ~/Projects/policy-navigator-app
//   deno test --allow-env --allow-net --node-modules-dir=auto --env=.env.local tests/db-client.test.ts

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import db from "../supabase/functions/_shared/db-client.ts";

Deno.test("db-client: initialises and reaches live Supabase project", async () => {
  // The `documents` table doesn't exist yet — a PostgREST 404/PGRST116 error
  // still proves the client initialised and authenticated correctly.
  const { data, error } = await db.from("documents").select("*").limit(1);

  console.log("PostgREST response — data:", JSON.stringify(data), "error:", JSON.stringify(error));

  // Auth or network failures surface as error.message containing "fetch" or
  // "invalid" — those are real failures. A missing-table error is a pass.
  if (error) {
    const msg = error.message.toLowerCase();
    const isTableMissing =
      msg.includes("does not exist") ||
      msg.includes("relation") ||
      msg.includes("42p01") ||
      msg.includes("schema cache") ||
      error.code === "PGRST116" ||
      error.code === "PGRST205" ||
      error.code === "42P01";

    assertEquals(
      isTableMissing,
      true,
      `Expected a missing-table error (table not yet created), got unexpected error: ${error.message} (code: ${error.code})`
    );
    console.log("PASS — PostgREST reached; table not yet created (expected).");
  } else {
    // data is an empty array if the table exists but is empty — also a pass.
    assertExists(data, "Expected data array from PostgREST");
    console.log("PASS — PostgREST reached; documents table exists (empty or populated).");
  }
});
