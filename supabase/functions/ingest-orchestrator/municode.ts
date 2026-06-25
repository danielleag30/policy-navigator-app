/**
 * Municode API ingestion handler (task 2-5).
 *
 * CORRECTED API flow (discovered during first ingestion run 2026-06-24):
 *
 *   Original code assumed /CodesContent returns a flat JSON array of all
 *   provision nodes.  Actual behavior:
 *
 *   1. /Jobs/latest/10051
 *        → { Id, Name, ProductId, ... }  (job metadata, not content)
 *
 *   2. /codesToc?clientId=5335&productId=10051&jobId=<jobId>
 *        → { Id, Heading, HasChildren, Children: [ depth-1 chapter nodes ] }
 *        NOTE: jobId is REQUIRED — the URL without jobId returns 404.
 *        NOTE: Children are only populated at the root call (depth -1→1).
 *              Chapters with HasChildren=true must be expanded separately.
 *
 *   3. /CodesContent?clientId=5335&productId=10051&jobId=<jobId>&nodeId=<Id>
 *        → { Docs: [{ Id, Content, NodeDepth, IsAmended, AmendedBy, Drafts }], ... }
 *        Content is an HTML string; root node Content is null.
 *
 *   This version ingests all depth-1 chapter nodes (105 for Fairfax County).
 *   Recursive sub-section ingestion is a v1.1 enhancement.
 *
 * Does NOT set documents.status or generate embeddings — orchestrator (task 2-6) owns that.
 */

import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { contentHash } from "../_shared/hash.ts";

const PRODUCT_ID = "10051";
const CLIENT_ID = "5335";
/** Polite inter-request delay in ms. */
const REQUEST_DELAY_MS = 300;

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
  NodeDepth: number;
  IsAmended: boolean;
  AmendedBy: unknown[];
  Drafts: unknown[];
}

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
  if (!resp.ok) {
    throw new Error(`Municode API HTTP ${resp.status} at ${url}`);
  }
  return resp.json();
}

/** Strip HTML tags and decode basic entities, returning plain text. */
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

/** default effective_date = today + 1 day (ISO date string). */
function defaultEffectiveDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface MunicodeResult {
  documentId: string;
  nodeIds: string[];
  skipped: boolean;
}

/**
 * Fetch Municode TOC + per-node content, create Document shell row,
 * insert ordinance_provisions rows for all depth-1 chapter nodes.
 */
export async function handleMunicode(
  pendingIngestionId: string,
): Promise<MunicodeResult> {
  const baseUrl = requireEnv("MUNICODE_BASE_URL");
  const userAgent = requireEnv("MUNICODE_USER_AGENT");

  // 1. Get latest job ID
  const jobsUrl = `${baseUrl}/Jobs/latest/${PRODUCT_ID}`;
  const jobPayload = await fetchJson(jobsUrl, userAgent) as Record<string, unknown>;
  const jobId = String(jobPayload?.Id ?? "");
  if (!jobId) throw new Error("Municode Jobs response missing required field: Id");
  console.log(`[municode] jobId=${jobId}`);

  await sleep(REQUEST_DELAY_MS);

  // 2. Fetch TOC — jobId is REQUIRED; without it the endpoint returns 404
  const tocUrl =
    `${baseUrl}/codesToc?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${jobId}`;
  const tocPayload = await fetchJson(tocUrl, userAgent) as TocNode;

  if (
    typeof tocPayload !== "object" || tocPayload === null ||
    !Array.isArray(tocPayload.Children)
  ) {
    throw new Error(
      "Municode codesToc response missing required field: Children",
    );
  }

  const chapterNodes: TocNode[] = tocPayload.Children;
  console.log(`[municode] TOC returned ${chapterNodes.length} depth-1 nodes`);

  // 3. Compute content_hash from TOC body for dedup
  const tocBody = JSON.stringify({ jobId, chapters: chapterNodes.map((n) => n.Id) });
  const hash = await contentHash(tocBody);

  // Dedup: skip if same hash already current
  const { data: existing, error: lookupErr } = await db
    .from("documents")
    .select("id")
    .eq("content_hash", hash)
    .eq("status", "current")
    .maybeSingle();

  if (lookupErr) throw new Error(`Municode dedup lookup failed: ${lookupErr.message}`);

  if (existing) {
    const { error: skipErr } = await db
      .from("pending_ingestions")
      .update({ status: "skipped", updated_at: new Date().toISOString() })
      .eq("id", pendingIngestionId);
    if (skipErr) {
      throw new Error(`Failed to mark Municode ingestion as skipped: ${skipErr.message}`);
    }
    console.log(`[municode] duplicate content_hash — skipped`);
    return { documentId: existing.id as string, nodeIds: [], skipped: true };
  }

  // 4. Create Document shell row at status='unknown'
  const now = new Date().toISOString();
  const documentId = uuidv7();
  const canonicalUrl =
    `${baseUrl}/CodesContent?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${jobId}`;

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
    raw_api_response: { jobId, toc_node_count: chapterNodes.length },
  });

  if (docErr) {
    throw new Error(`Municode document insert failed: ${docErr.message}`);
  }
  console.log(`[municode] document shell created: ${documentId}`);

  // 5. Fetch content for each chapter node and insert ordinance_provisions
  const nodeIds: string[] = [];
  const effectiveDate = defaultEffectiveDate();

  for (const chapter of chapterNodes) {
    await sleep(REQUEST_DELAY_MS);

    let contentDoc: ContentDoc | null = null;
    try {
      const contentUrl =
        `${baseUrl}/CodesContent?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${jobId}&nodeId=${chapter.Id}`;
      const contentResp = await fetchJson(contentUrl, userAgent) as Record<string, unknown>;
      const docs = contentResp?.Docs;
      if (Array.isArray(docs) && docs.length > 0) {
        contentDoc = docs[0] as ContentDoc;
      }
    } catch (e) {
      console.warn(`[municode] content fetch failed for ${chapter.Id}: ${(e as Error).message}`);
      continue;
    }

    const rawContent = contentDoc?.Content ?? null;
    if (rawContent === null || rawContent === "") {
      // Skip nodes with no content (e.g. root node, reserved/repealed chapters)
      console.log(`[municode] skipping ${chapter.Id} — null content`);
      continue;
    }

    const plainContent = stripHtml(rawContent);
    if (!plainContent) {
      console.log(`[municode] skipping ${chapter.Id} — empty after HTML strip`);
      continue;
    }

    const { error: provErr } = await db.from("ordinance_provisions").insert({
      id: uuidv7(),
      document_id: documentId,
      municode_node_id: chapter.Id,
      effective_date: effectiveDate,
      is_current: true,
      section_title: chapter.Heading ?? null,
      content: plainContent,
    });

    if (provErr?.code === "23505") {
      console.warn(`[municode] duplicate provision skipped: ${chapter.Id}`);
      continue;
    }

    if (provErr) {
      throw new Error(
        `Municode provision insert failed for ${chapter.Id}: ${provErr.message}`,
      );
    }

    nodeIds.push(chapter.Id);
  }

  console.log(
    `[municode] inserted ${nodeIds.length} ordinance_provisions for document ${documentId}`,
  );

  return { documentId, nodeIds, skipped: false };
}
