// Data API client (PostgREST-backed) for all Policy Navigator Edge Functions.
//
// This module creates and exports a single supabase-js client authenticated with
// the SERVICE_ROLE key. Every Edge Function imports this pre-instantiated client
// rather than calling createClient() itself.
//
// IMPORTANT — two distinct connection mechanisms exist; this file uses only one:
//
//   ┌─────────────────────────────────────────────────────────────────────────┐
//   │  THIS FILE — Data API client (PostgREST)                               │
//   │  createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)                 │
//   │  • HTTP/REST via PostgREST → Postgres                                  │
//   │  • Covers SELECT / INSERT / UPDATE / DELETE / RPC for all standard ops │
//   │  • Service-role: bypasses Row-Level Security, server-side only         │
//   │  • Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY                  │
//   ├─────────────────────────────────────────────────────────────────────────┤
//   │  NOT THIS FILE — raw Postgres pooler (if ever needed)                  │
//   │  Separate _shared/db-pool.ts, NOT pre-emptively created               │
//   │  • TCP connection to PgBouncer → Postgres                              │
//   │  • Required only for queries PostgREST cannot express (e.g. raw SQL   │
//   │    CTEs, advisory locks) — task 2-7 (RRF retrieval) evaluates this    │
//   │  • Env vars: SUPABASE_DB_POOLER_URL (port 6543), SUPABASE_DB_PASSWORD │
//   └─────────────────────────────────────────────────────────────────────────┘
//
// Usage in an Edge Function:
//   import db from "../_shared/db-client.ts";
//   const { data, error } = await db.from("documents").select("id").limit(10);

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
  );
}

const db = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    // Service-role clients must not persist sessions — they run server-side only.
    persistSession: false,
    autoRefreshToken: false,
  },
});

export default db;
