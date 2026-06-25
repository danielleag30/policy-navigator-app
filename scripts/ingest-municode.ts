/**
 * Local ingestion script — Municode API → Supabase ordinance_provisions
 *
 * Run with:
 *   deno run --allow-net --allow-env --allow-read scripts/ingest-municode.ts
 *
 * Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MUNICODE_BASE_URL,
 * MUNICODE_USER_AGENT from the environment (or .env.local via --env-file flag).
 *
 * This script replicates the logic in supabase/functions/ingest-orchestrator/municode.ts
 * so that a local run can populate the database for the task 3-6 smoke test
 * without requiring a successful Edge Function deploy.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

// ── Config ────────────────────────────────────────────────────────────────────

const PRODUCT_ID = "10051";
const CLIENT_ID = "5335";
const REQUEST_DELAY_MS = 300;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, userAgent: string): Promise<unknown> {
  const resp = await fetch(url, { headers: { "User-Agent": userAgent } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} at ${url}`);
  return resp.json();
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function defaultEffectiveDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── SHA-256 content hash (same as _shared/hash.ts) ───────────────────────────

async function contentHash(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface TocNode {
  Id: string;
  Heading: string;
  HasChildren: boolean;
  ParentId: string | null;
  NodeDepth: number;
  Children?: TocNode[];
}

interface ContentDoc {
  Id: string;
  Content: string | null;
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const baseUrl = requireEnv("MUNICODE_BASE_URL");
  const userAgent = requireEnv("MUNICODE_USER_AGENT");

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // 1. Get latest job ID
  console.log("Fetching Municode job ID...");
  const jobPayload = await fetchJson(`${baseUrl}/Jobs/latest/${PRODUCT_ID}`, userAgent) as Record<string, unknown>;
  const jobId = String(jobPayload?.Id ?? "");
  if (!jobId) throw new Error("Municode /Jobs/latest response missing Id field");
  console.log(`Job ID: ${jobId} (${jobPayload?.Name})`);

  await sleep(REQUEST_DELAY_MS);

  // 2. Fetch TOC (jobId is required)
  console.log("Fetching TOC...");
  const tocUrl = `${baseUrl}/codesToc?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${jobId}`;
  const tocPayload = await fetchJson(tocUrl, userAgent) as TocNode;
  if (!Array.isArray(tocPayload?.Children)) {
    throw new Error("codesToc response missing Children array");
  }
  const chapters: TocNode[] = tocPayload.Children;
  console.log(`TOC: ${chapters.length} depth-1 chapters`);

  await sleep(REQUEST_DELAY_MS);

  // 3. Dedup check
  const tocBody = JSON.stringify({ jobId, chapters: chapters.map((n) => n.Id) });
  const hash = await contentHash(tocBody);
  const { data: existing } = await db.from("documents").select("id").eq("content_hash", hash).eq("status", "current").maybeSingle();
  if (existing) {
    console.log(`Already ingested (content_hash match on document ${existing.id}). Nothing to do.`);
    return;
  }

  // 4. Create document shell
  const documentId = crypto.randomUUID();
  const now = new Date().toISOString();
  const canonicalUrl = `${baseUrl}/CodesContent?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${jobId}`;

  const { error: docErr } = await db.from("documents").insert({
    id: documentId,
    url: canonicalUrl,
    filename: null,
    doc_type: "municode_api",
    status: "unknown",
    ingested_at: now,
    last_checked_at: now,
    content_hash: hash,
    source_published_at: null,
    title: `Fairfax County Code of Ordinances — Supplement ${jobId}`,
    fiscal_year: null,
    docling_version: null,
    raw_api_response: { jobId, toc_node_count: chapters.length },
  });
  if (docErr) throw new Error(`Document insert failed: ${docErr.message}`);
  console.log(`Document shell created: ${documentId}`);

  // 5. Fetch + insert each chapter node
  const effectiveDate = defaultEffectiveDate();
  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    await sleep(REQUEST_DELAY_MS);

    let content: string | null = null;
    try {
      const contentUrl = `${baseUrl}/CodesContent?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${jobId}&nodeId=${chapter.Id}`;
      const resp = await fetchJson(contentUrl, userAgent) as Record<string, unknown>;
      const docs = resp?.Docs;
      if (Array.isArray(docs) && docs.length > 0) {
        content = (docs[0] as ContentDoc).Content ?? null;
      }
    } catch (e) {
      console.warn(`  [${i + 1}/${chapters.length}] FETCH ERROR ${chapter.Id}: ${(e as Error).message}`);
      skipped++;
      continue;
    }

    if (!content) {
      console.log(`  [${i + 1}/${chapters.length}] SKIP ${chapter.Id} — null content`);
      skipped++;
      continue;
    }

    const plain = stripHtml(content);
    if (!plain) {
      console.log(`  [${i + 1}/${chapters.length}] SKIP ${chapter.Id} — empty after strip`);
      skipped++;
      continue;
    }

    const { error: provErr } = await db.from("ordinance_provisions").insert({
      id: crypto.randomUUID(),
      document_id: documentId,
      municode_node_id: chapter.Id,
      effective_date: effectiveDate,
      is_current: true,
      section_title: chapter.Heading ?? null,
      content: plain,
    });

    if (provErr?.code === "23505") {
      console.warn(`  [${i + 1}/${chapters.length}] DUP ${chapter.Id}`);
      skipped++;
      continue;
    }
    if (provErr) throw new Error(`Provision insert failed for ${chapter.Id}: ${provErr.message}`);

    console.log(`  [${i + 1}/${chapters.length}] OK ${chapter.Id} — ${chapter.Heading}`);
    inserted++;
  }

  // 6. Finalize document
  await db.from("documents").update({ status: "current", updated_at: new Date().toISOString() }).eq("id", documentId);

  console.log(`\nDone. Inserted ${inserted} provisions, skipped ${skipped}.`);
  console.log(`Document ID: ${documentId}`);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  Deno.exit(1);
});
