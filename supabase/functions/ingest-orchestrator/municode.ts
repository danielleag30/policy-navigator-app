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
 *   3. /products/<clientId>/nodes/<nodeId>/children?depth=-1
 *        → TocNode[]  (full subtree for a given node, used for recursive expansion)
 *
 *   4. /CodesContent?clientId=5335&productId=10051&jobId=<jobId>&nodeId=<Id>
 *        → { Docs: [{ Id, Content, NodeDepth, IsAmended, AmendedBy, Drafts }], ... }
 *        Content is an HTML string; root node Content is null.
 *
 *   This version recursively ingests all nodes at all depths.  Every node with
 *   non-null HTML content is inserted as an ordinance_provisions row with
 *   parent_node_id and depth populated.
 *
 * Does NOT set documents.status or generate embeddings — orchestrator (task 2-6) owns that.
 */

import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { contentHash } from "../_shared/hash.ts";

const PRODUCT_ID = "10051";
const CLIENT_ID = "5335";
/** Polite delay between top-level API calls (job, TOC, chapter content). */
const REQUEST_DELAY_MS = 300;
/** Polite delay between recursive sub-section API calls (≥100ms per spec). */
const SUBSECTION_DELAY_MS = 100;

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

interface IngestContext {
  baseUrl: string;
  userAgent: string;
  jobId: string;
  documentId: string;
  effectiveDate: string;
  nodeIds: string[];
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

/**
 * Fetch all children of a given TOC node.
 * Returns an empty array when the response is not a JSON array.
 */
async function fetchNodeChildren(
  baseUrl: string,
  nodeId: string,
  userAgent: string,
): Promise<TocNode[]> {
  const url = `${baseUrl}/products/${CLIENT_ID}/nodes/${nodeId}/children?depth=-1`;
  const result = await fetchJson(url, userAgent);
  if (!Array.isArray(result)) {
    console.warn(`[municode] unexpected non-array children response for node ${nodeId}`);
    return [];
  }
  return result as TocNode[];
}

/**
 * Fetch content for a node, insert as ordinance_provisions, then recurse into children.
 * Skips nodes with null/empty content.  Catches 23505 (duplicate) without throwing.
 */
async function ingestNodeAndDescendants(
  node: TocNode,
  parentNodeId: string | null,
  depth: number,
  ctx: IngestContext,
): Promise<void> {
  let contentDoc: ContentDoc | null = null;
  try {
    const contentUrl =
      `${ctx.baseUrl}/CodesContent?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${ctx.jobId}&nodeId=${node.Id}`;
    const contentResp = await fetchJson(contentUrl, ctx.userAgent) as Record<string, unknown>;
    const docs = contentResp?.Docs;
    if (Array.isArray(docs) && docs.length > 0) {
      contentDoc = docs[0] as ContentDoc;
    }
  } catch (e) {
    console.warn(
      `[municode] content fetch failed for ${node.Id} (depth ${depth}): ${(e as Error).message}`,
    );
  }

  const rawContent = contentDoc?.Content ?? null;
  if (rawContent !== null && rawContent !== "") {
    const plainContent = stripHtml(rawContent);
    if (plainContent) {
      const { error: provErr } = await db.from("ordinance_provisions").insert({
        id: uuidv7(),
        document_id: ctx.documentId,
        municode_node_id: node.Id,
        parent_node_id: parentNodeId,
        depth,
        effective_date: ctx.effectiveDate,
        is_current: true,
        section_title: node.Heading ?? null,
        content: plainContent,
      });

      if (provErr?.code === "23505") {
        console.warn(`[municode] duplicate provision skipped: ${node.Id} (depth ${depth})`);
      } else if (provErr) {
        throw new Error(`Municode provision insert failed for ${node.Id}: ${provErr.message}`);
      } else {
        ctx.nodeIds.push(node.Id);
      }
    } else {
      console.log(`[municode] skipping ${node.Id} (depth ${depth}) — empty after HTML strip`);
    }
  } else {
    console.log(`[municode] skipping ${node.Id} (depth ${depth}) — null content`);
  }

  if (!node.HasChildren) return;

  // Children may already be embedded in the response (depth=-1 endpoint returns a full subtree);
  // only make a separate fetch when the Children array is absent/empty.
  let children = node.Children;
  if (!children || children.length === 0) {
    await sleep(SUBSECTION_DELAY_MS);
    try {
      children = await fetchNodeChildren(ctx.baseUrl, node.Id, ctx.userAgent);
    } catch (e) {
      console.warn(`[municode] children fetch failed for ${node.Id}: ${(e as Error).message}`);
      return;
    }
  }

  if (children.length === 0) return;
  console.log(`[municode] depth ${depth + 1}: ${children.length} children of ${node.Id}`);

  for (const child of children) {
    await sleep(SUBSECTION_DELAY_MS);
    await ingestNodeAndDescendants(child, node.Id, depth + 1, ctx);
  }
}

export interface MunicodeResult {
  documentId: string;
  nodeIds: string[];
  skipped: boolean;
}

/**
 * Fetch Municode TOC + per-node content, create Document shell row,
 * recursively insert ordinance_provisions rows for all nodes at all depths.
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

  // 5. Recursively ingest all nodes at all depths
  const nodeIds: string[] = [];
  const effectiveDate = defaultEffectiveDate();

  const ctx: IngestContext = {
    baseUrl,
    userAgent,
    jobId,
    documentId,
    effectiveDate,
    nodeIds,
  };

  const rootId = (tocPayload as TocNode).Id ?? null;
  for (const chapter of chapterNodes) {
    await sleep(REQUEST_DELAY_MS);
    await ingestNodeAndDescendants(chapter, rootId, 1, ctx);
  }

  console.log(
    `[municode] inserted ${nodeIds.length} ordinance_provisions for document ${documentId}`,
  );

  return { documentId, nodeIds, skipped: false };
}
