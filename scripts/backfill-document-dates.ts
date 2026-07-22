/**
 * One-time backfill: real documents.source_published_at / documents.fiscal_year
 * for already-ingested bos_minutes / bos_summary / budget_pdf documents.
 *
 * Root cause: these three doc_types never had source_published_at/fiscal_year
 * populated at ingestion time (see supabase/functions/_shared/document-date.ts
 * for the full writeup and the ingest-orchestrator/index.ts pdfBranch
 * finalize step, which now populates these going forward). This script
 * applies the identical logic to the existing backlog.
 *
 * Uses ONLY already-stored data (vote_tallies.meeting_date,
 * policy_decisions.meeting_date/fiscal_year, documents.url) — no live
 * re-fetch of any source PDF. Never fabricates: a document with no real
 * signal is left with source_published_at/fiscal_year NULL, same as before.
 *
 * Run with:
 *   deno run --allow-net --allow-env --allow-read --env-file=.env.local \
 *     scripts/backfill-document-dates.ts              # dry run (default)
 *   deno run --allow-net --allow-env --allow-read --env-file=.env.local \
 *     scripts/backfill-document-dates.ts --apply       # writes for real
 *
 * Resumable: only ever touches rows where source_published_at IS NULL, so a
 * partial run (or a re-run after this script's own writes) is naturally
 * idempotent — already-backfilled rows are simply skipped on the next pass.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  computeDocumentDateMetadata,
  parseDateFromUrl,
} from "../supabase/functions/_shared/document-date.ts";

const PAGE_SIZE = 200;
const DOC_TYPES = ["bos_minutes", "bos_summary", "budget_pdf"] as const;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const apply = Deno.args.includes("--apply");

const db = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

interface DocRow {
  id: string;
  doc_type: string;
  url: string;
}

interface Stats {
  total: number;
  gotDate: number;
  gotDateFromExtraction: number;
  gotDateFromUrl: number;
  gotFiscalYear: number;
  gotNeither: number;
}

function emptyStats(): Stats {
  return {
    total: 0,
    gotDate: 0,
    gotDateFromExtraction: 0,
    gotDateFromUrl: 0,
    gotFiscalYear: 0,
    gotNeither: 0,
  };
}

async function main() {
  console.log(`[backfill] mode: ${apply ? "APPLY (writing)" : "DRY RUN (no writes)"}`);

  const statsByType: Record<string, Stats> = {
    bos_minutes: emptyStats(),
    bos_summary: emptyStats(),
    budget_pdf: emptyStats(),
  };
  const samples: Array<
    { id: string; doc_type: string; url: string; before: null; after: unknown }
  > = [];
  const neitherSamples: Array<{ id: string; doc_type: string; url: string }> = [];

  for (const docType of DOC_TYPES) {
    // Cursor pagination by id, NOT offset-based .range(). With --apply this
    // loop writes source_published_at as it goes, which shrinks the
    // `WHERE source_published_at IS NULL` result set page over page — an
    // offset-based range() would then skip rows (the exact bug an earlier
    // dry run of this script caught: it silently skipped every row past
    // whatever the previous page had already fixed). A cursor on the
    // monotonic id column is stable regardless of concurrent writes and is
    // resumable if the script is interrupted and re-run.
    let cursor: string | null = null;
    for (;;) {
      let query = db
        .from("documents")
        .select("id, doc_type, url")
        .eq("doc_type", docType)
        .is("source_published_at", null)
        .order("id")
        .limit(PAGE_SIZE);
      if (cursor !== null) {
        query = query.gt("id", cursor);
      }
      const { data: rows, error } = await query;

      if (error) {
        throw new Error(`fetch page failed (${docType}, cursor=${cursor}): ${error.message}`);
      }
      if (!rows || rows.length === 0) break;
      cursor = (rows[rows.length - 1] as DocRow).id;

      for (const row of rows as DocRow[]) {
        const stats = statsByType[docType];
        stats.total++;

        // Need the extraction signal separately from the URL fallback purely
        // for reporting (which tier actually supplied the date) — recompute
        // via the same shared function, then a URL-only call to attribute it.
        const result = await computeDocumentDateMetadata(
          // deno-lint-ignore no-explicit-any
          db as any,
          row.id,
          row.doc_type,
          row.url,
        );

        if (result.sourcePublishedAt) {
          stats.gotDate++;
          const urlOnly = parseDateFromUrl(row.url);
          if (urlOnly === result.sourcePublishedAt) {
            stats.gotDateFromUrl++;
          } else {
            stats.gotDateFromExtraction++;
          }
        }
        if (result.fiscalYear !== null) stats.gotFiscalYear++;
        if (!result.sourcePublishedAt && result.fiscalYear === null) stats.gotNeither++;

        if (samples.length < 12 && result.sourcePublishedAt) {
          samples.push({
            id: row.id,
            doc_type: row.doc_type,
            url: row.url,
            before: null,
            after: result,
          });
        }
        if (!result.sourcePublishedAt && result.fiscalYear === null) {
          neitherSamples.push({ id: row.id, doc_type: row.doc_type, url: row.url });
        }

        if (apply && (result.sourcePublishedAt !== null || result.fiscalYear !== null)) {
          const { error: updateErr } = await db
            .from("documents")
            .update({
              source_published_at: result.sourcePublishedAt,
              fiscal_year: result.fiscalYear,
            })
            .eq("id", row.id);
          if (updateErr) {
            throw new Error(`update failed for document ${row.id}: ${updateErr.message}`);
          }
        }
      }

      console.log(
        `[backfill] ${docType}: processed ${
          statsByType[docType].total
        } so far (this page: ${rows.length})`,
      );
    }
  }

  console.log("\n=== Backfill summary (documents with source_published_at IS NULL at start) ===");
  let grandTotal = 0, grandDate = 0, grandFy = 0, grandNeither = 0;
  for (const docType of DOC_TYPES) {
    const s = statsByType[docType];
    grandTotal += s.total;
    grandDate += s.gotDate;
    grandFy += s.gotFiscalYear;
    grandNeither += s.gotNeither;
    console.log(
      `${docType}: total=${s.total} gotDate=${s.gotDate} (extraction=${s.gotDateFromExtraction}, url=${s.gotDateFromUrl}) gotFiscalYear=${s.gotFiscalYear} gotNeither=${s.gotNeither}`,
    );
  }
  console.log(
    `TOTAL: total=${grandTotal} gotDate=${grandDate} gotFiscalYear=${grandFy} gotNeither=${grandNeither}`,
  );

  console.log("\n=== Sample resolved rows (up to 12) ===");
  for (const s of samples) {
    console.log(JSON.stringify(s));
  }

  console.log(`\n=== Documents with neither signal (honest gaps, ${neitherSamples.length}) ===`);
  for (const s of neitherSamples) {
    console.log(JSON.stringify(s));
  }

  if (!apply) {
    console.log("\n[backfill] Dry run complete — no rows written. Re-run with --apply to write.");
  } else {
    console.log("\n[backfill] Apply complete.");
  }
}

await main();
