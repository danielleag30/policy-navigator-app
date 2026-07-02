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
 * DEADLINE-AWARE RESUMABLE WALK (fix, this file's current revision):
 *
 *   The node tree is walked iteratively with an explicit stack (LIFO, same
 *   visiting order as the original recursive depth-first walk) instead of
 *   real recursion, so the walk can be paused and resumed across separate
 *   Edge Function invocations. Before popping each stack item, elapsed time
 *   is checked against `deadlineMs` (passed in by index.ts, mirroring the
 *   PDF branch's SOFT_DEADLINE_MS pattern). If the budget is exhausted, the
 *   remaining stack is persisted to `documents.municode_resume_state` and
 *   the function returns `complete: false`; the caller must requeue the
 *   PendingIngestion row without treating it as a failure. The NEXT
 *   invocation finds this row (doc_type='municode_api', status='unknown',
 *   municode_resume_state IS NOT NULL) and resumes from the saved stack
 *   instead of restarting from chapter 1 — see `findResumableDocument()`.
 *
 * SUPERSESSION (fix, this file's current revision):
 *
 *   Per-node dedup now happens at the ordinance_provisions row level, not
 *   just the top-level TOC content_hash. Before inserting a node's content,
 *   the existing is_current=true row for that municode_node_id (if any) is
 *   looked up:
 *     - same content_hash  → unchanged content; skip insert entirely.
 *     - different content_hash → genuine amendment; flip the old row to
 *       is_current=false with superseded_date set, then insert the new row.
 *
 * FORCED FULL RE-INGESTION (fix, this file's current revision):
 *
 *   Normally, when the TOC-level content_hash matches an existing
 *   status='current' document, the run is skipped entirely (periodic
 *   re-check found no change upstream). `forceFullReingest` (gated by
 *   ADMIN_SECRET in index.ts — never set by the cron poll path) bypasses
 *   that early skip and instead reuses the existing document's id, flips it
 *   to status='unknown' with a fresh resume queue, and walks the full tree.
 *   Per-node content_hash checks above mean already-ingested chapter rows
 *   with unchanged content are left untouched (no duplicate, no
 *   supersession) while previously-unexplored children get inserted.
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
/** Buffer before the soft deadline at which the walk pauses and persists resume state. */
const DEADLINE_BUFFER_MS = 20_000; // 20 s buffer before hard kill — matches extractor.ts

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

/** A single unit of resumable work: one TOC node awaiting content fetch + expansion. */
interface QueueItem {
  id: string;
  heading: string;
  hasChildren: boolean;
  parentNodeId: string | null;
  depth: number;
}

/** Serialized shape persisted to documents.municode_resume_state. */
interface ResumeState {
  jobId: string;
  effectiveDate: string;
  queue: QueueItem[];
}

interface IngestContext {
  baseUrl: string;
  userAgent: string;
  jobId: string;
  documentId: string;
  effectiveDate: string;
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
  jobId: string,
  nodeId: string,
  userAgent: string,
): Promise<TocNode[]> {
  const url =
    `${baseUrl}/codesToc/children?jobId=${jobId}&productId=${PRODUCT_ID}&nodeId=${nodeId}`;
  const result = await fetchJson(url, userAgent);
  if (!Array.isArray(result)) {
    console.warn(
      `[municode] unexpected non-array children response for node ${nodeId}`,
    );
    return [];
  }
  return result as TocNode[];
}

/**
 * Insert a node's content as an ordinance_provisions row, applying
 * per-node supersession: unchanged content vs. an existing is_current row
 * is skipped; genuinely different content flips the old row to
 * is_current=false (with superseded_date) before inserting the new one.
 */
async function upsertProvision(
  item: QueueItem,
  ctx: IngestContext,
  plainContent: string,
): Promise<void> {
  const newHash = await contentHash(plainContent);

  const { data: existing, error: lookupErr } = await db
    .from("ordinance_provisions")
    .select("id, content_hash")
    .eq("municode_node_id", item.id)
    .eq("is_current", true)
    .maybeSingle();

  if (lookupErr) {
    throw new Error(
      `ordinance_provisions current-row lookup failed for ${item.id}: ${lookupErr.message}`,
    );
  }

  if (existing && existing.content_hash === newHash) {
    console.log(
      `[municode] unchanged content — skipping ${item.id} (depth ${item.depth})`,
    );
    return;
  }

  if (existing) {
    const { error: supersedeErr } = await db
      .from("ordinance_provisions")
      .update({
        is_current: false,
        superseded_date: ctx.effectiveDate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (supersedeErr) {
      throw new Error(
        `Failed to supersede prior ordinance_provisions row for ${item.id}: ${supersedeErr.message}`,
      );
    }
    console.log(
      `[municode] superseded prior version of ${item.id} (superseded_date=${ctx.effectiveDate})`,
    );
  }

  const { error: provErr } = await db.from("ordinance_provisions").insert({
    id: uuidv7(),
    document_id: ctx.documentId,
    municode_node_id: item.id,
    parent_node_id: item.parentNodeId,
    depth: item.depth,
    effective_date: ctx.effectiveDate,
    is_current: true,
    section_title: item.heading ?? null,
    content: plainContent,
    content_hash: newHash,
  });

  if (provErr?.code === "23505") {
    console.warn(
      `[municode] duplicate provision skipped: ${item.id} (depth ${item.depth})`,
    );
  } else if (provErr) {
    throw new Error(
      `Municode provision insert failed for ${item.id}: ${provErr.message}`,
    );
  }
}

/**
 * Fetch content for one queued node, upsert it (supersession-aware), and
 * return its children (if any) so the caller can push them onto the walk
 * stack. Descent into children happens regardless of whether the content
 * insert was skipped as unchanged — a forced re-ingest needs to reach
 * previously-unexplored children of an already-ingested, unchanged chapter.
 */
async function processNode(
  item: QueueItem,
  ctx: IngestContext,
): Promise<TocNode[]> {
  let contentDoc: ContentDoc | null = null;
  try {
    const contentUrl =
      `${ctx.baseUrl}/CodesContent?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${ctx.jobId}&nodeId=${item.id}`;
    const contentResp = await fetchJson(contentUrl, ctx.userAgent) as Record<
      string,
      unknown
    >;
    const docs = contentResp?.Docs;
    // /CodesContent returns the whole "chunk group" the requested node belongs
    // to (e.g. a chapter + article + every sibling section under it), not a
    // single-element array scoped to nodeId — the requested node can appear
    // at any index. Match by Id; docs[0] is frequently a different (often
    // content-less chapter/article header) node.
    if (Array.isArray(docs)) {
      contentDoc = (docs as ContentDoc[]).find((d) => d.Id === item.id) ?? null;
    }
  } catch (e) {
    console.warn(
      `[municode] content fetch failed for ${item.id} (depth ${item.depth}): ${
        (e as Error).message
      }`,
    );
  }

  const rawContent = contentDoc?.Content ?? null;
  if (rawContent !== null && rawContent !== "") {
    const plainContent = stripHtml(rawContent);
    if (plainContent) {
      await upsertProvision(item, ctx, plainContent);
    } else {
      console.log(
        `[municode] skipping ${item.id} (depth ${item.depth}) — empty after HTML strip`,
      );
    }
  } else {
    console.log(
      `[municode] skipping ${item.id} (depth ${item.depth}) — null content`,
    );
  }

  if (!item.hasChildren) return [];

  await sleep(SUBSECTION_DELAY_MS);
  try {
    const children = await fetchNodeChildren(
      ctx.baseUrl,
      ctx.jobId,
      item.id,
      ctx.userAgent,
    );
    if (children.length > 0) {
      console.log(
        `[municode] depth ${
          item.depth + 1
        }: ${children.length} children of ${item.id}`,
      );
    }
    return children;
  } catch (e) {
    console.warn(
      `[municode] children fetch failed for ${item.id}: ${
        (e as Error).message
      }`,
    );
    return [];
  }
}

/** Push a node's children onto the LIFO stack in an order that preserves DFS pre-order visiting. */
function pushChildren(
  queue: QueueItem[],
  children: TocNode[],
  parentNodeId: string | null,
  depth: number,
): void {
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    queue.push({
      id: child.Id,
      heading: child.Heading,
      hasChildren: child.HasChildren,
      parentNodeId,
      depth,
    });
  }
}

/**
 * Drain the walk stack, checking the soft deadline before each item. On
 * deadline exhaustion, persists the remaining stack to
 * documents.municode_resume_state and returns complete: false. On full
 * drain, clears any resume state and returns the full current node id list
 * for this document (queried fresh from the DB so it's correct across
 * however many invocations the walk took to finish).
 */
async function drainQueue(
  queue: QueueItem[],
  ctx: IngestContext,
  deadlineMs: number | undefined,
  hadResumeState: boolean,
): Promise<MunicodeResult> {
  while (queue.length > 0) {
    if (
      deadlineMs !== undefined && Date.now() >= deadlineMs - DEADLINE_BUFFER_MS
    ) {
      const state: ResumeState = {
        jobId: ctx.jobId,
        effectiveDate: ctx.effectiveDate,
        queue,
      };
      const { error: persistErr } = await db
        .from("documents")
        .update({
          municode_resume_state: state,
          updated_at: new Date().toISOString(),
        })
        .eq("id", ctx.documentId);
      if (persistErr) {
        throw new Error(
          `Failed to persist Municode resume state: ${persistErr.message}`,
        );
      }
      console.warn(
        `[municode] soft deadline hit with ${queue.length} node(s) remaining; persisted resume state for document ${ctx.documentId}`,
      );
      return {
        documentId: ctx.documentId,
        nodeIds: [],
        skipped: false,
        complete: false,
      };
    }

    const item = queue.pop()!;
    await sleep(item.depth <= 1 ? REQUEST_DELAY_MS : SUBSECTION_DELAY_MS);
    const children = await processNode(item, ctx);
    if (children.length > 0) {
      pushChildren(queue, children, item.id, item.depth + 1);
    }
  }

  if (hadResumeState) {
    const { error: clearErr } = await db
      .from("documents")
      .update({
        municode_resume_state: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", ctx.documentId);
    if (clearErr) {
      throw new Error(
        `Failed to clear Municode resume state: ${clearErr.message}`,
      );
    }
  }

  const { data: rows, error: nodeIdsErr } = await db
    .from("ordinance_provisions")
    .select("municode_node_id")
    .eq("document_id", ctx.documentId);
  if (nodeIdsErr) {
    throw new Error(
      `Failed to read back ordinance_provisions node ids: ${nodeIdsErr.message}`,
    );
  }
  const nodeIds = (rows ?? []).map((r) => r.municode_node_id as string);

  console.log(
    `[municode] walk complete: ${nodeIds.length} ordinance_provisions total for document ${ctx.documentId}`,
  );

  return {
    documentId: ctx.documentId,
    nodeIds,
    skipped: false,
    complete: true,
  };
}

/** Finds an in-progress Municode document (soft-deadline-paused mid-walk) to resume, if any. */
async function findResumableDocument(): Promise<
  { documentId: string; state: ResumeState } | null
> {
  const { data, error: findErr } = await db
    .from("documents")
    .select("id, municode_resume_state")
    .eq("doc_type", "municode_api")
    .eq("status", "unknown")
    .not("municode_resume_state", "is", null)
    .order("ingested_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (findErr) {
    throw new Error(
      `Municode resumable-document lookup failed: ${findErr.message}`,
    );
  }
  if (!data) return null;

  return {
    documentId: data.id as string,
    state: data.municode_resume_state as ResumeState,
  };
}

export interface MunicodeResult {
  documentId: string;
  nodeIds: string[];
  skipped: boolean;
  /** false when the soft deadline was hit mid-walk and a resume is needed on the next invocation. */
  complete: boolean;
}

/**
 * Fetch Municode TOC + per-node content, create Document shell row,
 * iteratively insert ordinance_provisions rows for all nodes at all depths,
 * pausing and persisting a resume cursor if the soft deadline is hit.
 *
 * @param forceFullReingest  When true, bypasses the top-level content_hash
 *   skip and reuses the existing matching document to re-walk the full
 *   tree (see file header). Callers must gate this behind admin auth —
 *   never set on the normal cron poll path.
 */
export async function handleMunicode(
  pendingIngestionId: string,
  deadlineMs?: number,
  forceFullReingest = false,
): Promise<MunicodeResult> {
  const baseUrl = requireEnv("MUNICODE_BASE_URL");
  const userAgent = requireEnv("MUNICODE_USER_AGENT");

  // 0. Resume in-progress walk, if any — skip Jobs/TOC/dedup entirely.
  const resumable = await findResumableDocument();
  if (resumable) {
    console.log(
      `[municode] resuming in-progress walk for document ${resumable.documentId}`,
    );
    const ctx: IngestContext = {
      baseUrl,
      userAgent,
      jobId: resumable.state.jobId,
      documentId: resumable.documentId,
      effectiveDate: resumable.state.effectiveDate,
    };
    return await drainQueue(resumable.state.queue, ctx, deadlineMs, true);
  }

  // 1. Get latest job ID
  const jobsUrl = `${baseUrl}/Jobs/latest/${PRODUCT_ID}`;
  const jobPayload = await fetchJson(jobsUrl, userAgent) as Record<
    string,
    unknown
  >;
  const jobId = String(jobPayload?.Id ?? "");
  if (!jobId) {
    throw new Error("Municode Jobs response missing required field: Id");
  }
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
  const tocBody = JSON.stringify({
    jobId,
    chapters: chapterNodes.map((n) => n.Id),
  });
  const hash = await contentHash(tocBody);

  // Dedup: an existing status='current' document with the same TOC hash means
  // Municode returned unchanged content since the last successful run.
  const { data: existing, error: lookupErr } = await db
    .from("documents")
    .select("id")
    .eq("content_hash", hash)
    .eq("status", "current")
    .maybeSingle();

  if (lookupErr) {
    throw new Error(`Municode dedup lookup failed: ${lookupErr.message}`);
  }

  const rootId = (tocPayload as TocNode).Id ?? null;
  const effectiveDate = defaultEffectiveDate();
  let documentId: string;

  if (existing && !forceFullReingest) {
    const { error: skipErr } = await db
      .from("pending_ingestions")
      .update({ status: "skipped", updated_at: new Date().toISOString() })
      .eq("id", pendingIngestionId);
    if (skipErr) {
      throw new Error(
        `Failed to mark Municode ingestion as skipped: ${skipErr.message}`,
      );
    }
    console.log(`[municode] duplicate content_hash — skipped`);
    return {
      documentId: existing.id as string,
      nodeIds: [],
      skipped: true,
      complete: true,
    };
  } else if (existing && forceFullReingest) {
    // Reuse the existing document row (its url/content_hash are unchanged)
    // and flip it back to in-progress so per-node content_hash checks can
    // naturally leave unchanged chapters untouched while reaching their
    // previously-unexplored children.
    documentId = existing.id as string;
    const { error: reopenErr } = await db
      .from("documents")
      .update({ status: "unknown", updated_at: new Date().toISOString() })
      .eq("id", documentId);
    if (reopenErr) {
      throw new Error(
        `Failed to reopen document for forced re-ingest: ${reopenErr.message}`,
      );
    }
    console.log(
      `[municode] force_full_reingest — reopened existing document ${documentId}`,
    );
  } else {
    // 4. Create Document shell row at status='unknown'
    const now = new Date().toISOString();
    documentId = uuidv7();
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
  }

  // 5. Iteratively walk all nodes at all depths (LIFO stack — DFS pre-order,
  // matching the original recursive visiting order).
  const queue: QueueItem[] = [];
  pushChildren(queue, chapterNodes, rootId, 1);

  const ctx: IngestContext = {
    baseUrl,
    userAgent,
    jobId,
    documentId,
    effectiveDate,
  };
  return await drainQueue(queue, ctx, deadlineMs, false);
}
