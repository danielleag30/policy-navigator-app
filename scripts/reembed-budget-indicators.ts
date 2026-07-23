/**
 * Re-embed existing budget_indicators with structured-column embedding input.
 *
 * HOLD FOR POST-REVIEW: do not run this against production until the PR is
 * reviewed and merged.
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   HF_SPACES_DOCLING_URL
 *
 * Optional env:
 *   BUDGET_INDICATOR_REEMBED_WRITE=true  Persist embeddings. Omit for dry-run.
 *   START_AFTER_ID=<uuid>                Resume after the last printed cursor.
 *   REEMBED_LIMIT=<number>               Stop after this many rows.
 *   REEMBED_DEADLINE_MS=<number>         Wall-clock budget, default 60000.
 *   REEMBED_PAGE_SIZE=<number>           DB page size, default 50.
 */

import { createClient } from "@supabase/supabase-js";
import {
  budgetIndicatorEmbeddingInput,
  type BudgetIndicatorEmbeddingInputRow,
} from "../supabase/functions/_shared/budget-indicator.ts";
import {
  generateEmbeddingsHttpBatched,
  persistEmbeddings,
} from "../supabase/functions/_shared/embedder.ts";

interface BudgetIndicatorReembedRow extends BudgetIndicatorEmbeddingInputRow {
  id: string;
  documents: { budget_stage: string | null } | null;
}

type BudgetIndicatorFetchedRow = Omit<BudgetIndicatorReembedRow, "documents"> & {
  documents?: { budget_stage: string | null } | Array<{ budget_stage: string | null }> | null;
};

const MIN_UUID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_DEADLINE_MS = 60_000;
const DEADLINE_BUFFER_MS = 5_000;

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const supabaseUrl = requiredEnv("SUPABASE_URL");
const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const embedUrl = requiredEnv("HF_SPACES_DOCLING_URL");
const writeEnabled = Deno.env.get("BUDGET_INDICATOR_REEMBED_WRITE") === "true";
const pageSize = positiveIntEnv("REEMBED_PAGE_SIZE", DEFAULT_PAGE_SIZE);
const deadlineMs = positiveIntEnv("REEMBED_DEADLINE_MS", DEFAULT_DEADLINE_MS);
const maxRows = Deno.env.get("REEMBED_LIMIT")
  ? positiveIntEnv("REEMBED_LIMIT", Number.MAX_SAFE_INTEGER)
  : Number.MAX_SAFE_INTEGER;

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let cursor = Deno.env.get("START_AFTER_ID") ?? MIN_UUID;
let processed = 0;
const startMs = Date.now();

console.log(
  `[budget-reembed] mode=${
    writeEnabled ? "write" : "dry-run"
  } start_after=${cursor} page_size=${pageSize} deadline_ms=${deadlineMs}`,
);

while (processed < maxRows) {
  if (Date.now() - startMs >= deadlineMs - DEADLINE_BUFFER_MS) {
    console.warn(
      `[budget-reembed] soft deadline reached before next page; resume with START_AFTER_ID=${cursor}`,
    );
    Deno.exit(0);
  }

  const limit = Math.min(pageSize, maxRows - processed);
  const pageStartCursor = cursor;
  const { data: rows, error } = await db
    .from("budget_indicators")
    .select(
      "id, fiscal_year, department, program, indicator_name, value_actual, value_target, value_prior_year, unit, effective_date, effective_date_source, chunk_sequence, documents(budget_stage)",
    )
    .gt("id", cursor)
    .order("id")
    .limit(limit);

  if (error) throw new Error(`budget_indicators fetch failed: ${error.message}`);
  if (!rows || rows.length === 0) {
    console.log(`[budget-reembed] complete processed=${processed}`);
    Deno.exit(0);
  }

  const typedRows = (rows as unknown as BudgetIndicatorFetchedRow[]).map((row) => {
    const documents = Array.isArray(row.documents)
      ? row.documents[0] ?? null
      : row.documents ?? null;
    return { ...row, documents };
  });
  const inputs = typedRows.map(budgetIndicatorEmbeddingInput);
  const embeddings = await generateEmbeddingsHttpBatched(embedUrl, inputs);

  const nullCount = embeddings.filter((embedding) => embedding === null).length;
  if (nullCount > 0) {
    throw new Error(
      `embedding generation returned ${nullCount} null vector(s); resume with START_AFTER_ID=${pageStartCursor}`,
    );
  }

  if (writeEnabled) {
    await persistEmbeddings(db, "budget_indicators", "budget_indicator", typedRows, embeddings);
  }

  processed += typedRows.length;
  cursor = typedRows[typedRows.length - 1].id;
  console.log(
    `[budget-reembed] processed=${processed} last_id=${cursor} null_embeddings=${nullCount}`,
  );
}

console.log(
  `[budget-reembed] limit reached processed=${processed}; resume with START_AFTER_ID=${cursor}`,
);
