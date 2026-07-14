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
 * CONCURRENCY (audit remediation, this file's current revision):
 *
 *   Two hazards exist when concurrent ingest-orchestrator invocations both
 *   process municode_api rows (plausible given overlapping pending_ingestions
 *   triggers from the watchdog):
 *     1. Resume-state race: findResumableDocument() now atomically claims a
 *        paused document via a single conditional UPDATE ... WHERE ...
 *        RETURNING against documents.resume_claim_expires_at before draining
 *        its queue, instead of read-then-write. A losing invocation reports
 *        complete:false without starting a duplicate fresh job.
 *     2. Supersession race: the supersede UPDATE in upsertProvision() is
 *        guarded by `WHERE is_current = true` (atomic conditional update),
 *        and the ordinance_provisions_one_current_per_node_idx partial
 *        unique index (migration 002) makes a duplicate is_current=true
 *        insert impossible even under a race — the resulting 23505 is
 *        caught and treated as "already inserted by another process, skip".
 *
 * ORPHAN RECOVERY (fix, this file's current revision):
 *
 *   findResumableDocument() only recognizes an in-progress walk via a
 *   non-null municode_resume_state. If a walk fully drains (resume_state
 *   cleared) but the calling Edge Function invocation crashes before
 *   index.ts finishes embedOrdinanceProvisions()/finalization,
 *   documents.status never flips to 'current' and resume_state stays null —
 *   a third state findResumableDocument() cannot see. Every subsequent
 *   retry would fall through to the fresh-insert branch and fail forever on
 *   the documents_url_key unique constraint. The fresh-insert branch now
 *   first looks up any existing document row at the canonical URL
 *   (classifyOrphanRecovery() in _municode-helpers.ts) and recovers by:
 *     - reusing it and skipping straight to finalization if its
 *       ordinance_provisions rows are already written (walk was complete), or
 *     - reusing it and re-walking from the root if no provisions exist yet
 *       (the prior attempt crashed before making any progress).
 *   Before acting on either outcome, the orphan row is atomically claimed via
 *   the same conditional UPDATE ... WHERE ... RETURNING pattern (and the
 *   same resume_claim_expires_at column) findResumableDocument() uses below,
 *   closing the same class of concurrent-invocation race CONCURRENCY hazard
 *   1 addresses for the resume-state lease — see the claim in the
 *   fresh-insert branch.
 *
 * Does NOT set documents.status or generate embeddings — orchestrator (task 2-6) owns that.
 */

import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { contentHash } from "../_shared/hash.ts";
import { generateEmbeddingsHttp } from "../_shared/embedder.ts";
import {
  buildCurrentIdentityIndex,
  classifyOrphanRecovery,
  type CurrentIdentityIndex,
  DEFAULT_HISTORICAL_CHAPTER_PREFIXES,
  DEFAULT_HISTORICAL_SUPPLEMENTS,
  headingMatchesHistoricalChapter,
  type MunicodeJobSummary,
  normalizeOnlineDate,
  resolveHistoricalIdentity,
  scheduleHistoricalEmbeddingRetry,
  type SelectedHistoricalJob,
  selectHistoricalJobs,
} from "./_municode-helpers.ts";

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
  mode?: "current" | "historical";
  jobId: string;
  effectiveDate: string;
  queue: QueueItem[];
  historicalJob?: SelectedHistoricalJob;
}

interface IngestContext {
  mode?: "current" | "historical";
  baseUrl: string;
  userAgent: string;
  jobId: string;
  documentId: string;
  effectiveDate: string;
}

interface HistoricalIngestContext extends IngestContext {
  job: SelectedHistoricalJob;
  identityIndex: CurrentIdentityIndex;
  embedUrl: string | null;
  supersededDate: string | null;
}

const HISTORICAL_EMBED_PREFLIGHT_TIMEOUT_MS = 20_000;

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

function effectiveDateFromJob(jobPayload: Record<string, unknown>): string {
  const onlineDate = normalizeOnlineDate(String(jobPayload?.OnlineDate ?? ""));
  return onlineDate ?? defaultEffectiveDate();
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
    // WHERE is_current = true (not just id) makes this an atomic conditional
    // update: Postgres row-level locking serializes concurrent UPDATEs on the
    // same row, so a second concurrent supersede attempt naturally matches
    // zero rows once the first has already flipped it. The remaining half of
    // the race — two concurrent processes both reaching the INSERT below
    // with is_current=true for the same node — is closed by the
    // ordinance_provisions_one_current_per_node_idx partial unique index
    // (migration 002); the 23505 catch after the insert treats that as
    // "another process already inserted the current version — skip".
    const { error: supersedeErr } = await db
      .from("ordinance_provisions")
      .update({
        is_current: false,
        superseded_date: ctx.effectiveDate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .eq("is_current", true);
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

async function persistHistoricalEmbedding(
  ctx: HistoricalIngestContext,
  provisionId: string,
  content: string,
): Promise<void> {
  if (!ctx.embedUrl) return;

  const [embedding] = await generateEmbeddingsHttp(ctx.embedUrl, [content]);
  if (!embedding) {
    console.warn(
      `[municode-history] null embedding for historical provision ${provisionId}`,
    );
    return;
  }

  const { error: updateErr } = await db
    .from("ordinance_provisions")
    .update({ embedding, updated_at: new Date().toISOString() })
    .eq("id", provisionId);
  if (updateErr) {
    throw new Error(
      `Failed to persist historical embedding for ${provisionId}: ${updateErr.message}`,
    );
  }
}

async function availableHistoricalEmbedUrl(
  embedUrl: string | null,
): Promise<string | null> {
  if (!embedUrl) return null;
  const [embedding] = await generateEmbeddingsHttp(
    embedUrl,
    ["municode historical embedding preflight"],
    HISTORICAL_EMBED_PREFLIGHT_TIMEOUT_MS,
  );
  if (!embedding) {
    console.warn(
      "[municode-history] /embed preflight failed; historical rows will be inserted without blocking on per-row embedding this invocation",
    );
    return null;
  }
  return embedUrl;
}

async function upsertHistoricalProvision(
  item: QueueItem,
  ctx: HistoricalIngestContext,
  plainContent: string,
): Promise<void> {
  const newHash = await contentHash(plainContent);
  const identity = resolveHistoricalIdentity({
    rawNodeId: item.id,
    heading: item.heading,
    content: plainContent,
    currentNodeIds: ctx.identityIndex.currentNodeIds,
    citationToCurrentNodeId: ctx.identityIndex.citationToCurrentNodeId,
  });

  const { data: existing, error: lookupErr } = await db
    .from("ordinance_provisions")
    .select("id, content_hash, embedding")
    .eq("municode_node_id", identity.nodeId)
    .eq("effective_date", ctx.effectiveDate)
    .maybeSingle();

  if (lookupErr) {
    throw new Error(
      `historical ordinance_provisions lookup failed for ${identity.nodeId}: ${lookupErr.message}`,
    );
  }

  if (existing) {
    if (existing.content_hash === newHash) {
      if (!existing.embedding) {
        await persistHistoricalEmbedding(
          ctx,
          existing.id as string,
          plainContent,
        );
      }
      console.log(
        `[municode-history] existing snapshot skipped ${identity.nodeId} (${ctx.effectiveDate})`,
      );
      return;
    }

    const { error: updateErr } = await db
      .from("ordinance_provisions")
      .update({
        parent_node_id: item.parentNodeId,
        depth: item.depth,
        is_current: false,
        superseded_date: ctx.supersededDate,
        section_title: item.heading ?? null,
        content: plainContent,
        content_hash: newHash,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id as string);
    if (updateErr) {
      throw new Error(
        `Failed to update historical provision ${existing.id}: ${updateErr.message}`,
      );
    }
    await persistHistoricalEmbedding(ctx, existing.id as string, plainContent);
    return;
  }

  const provisionId = uuidv7();
  const { error: insertErr } = await db.from("ordinance_provisions").insert({
    id: provisionId,
    document_id: ctx.documentId,
    municode_node_id: identity.nodeId,
    parent_node_id: item.parentNodeId,
    depth: item.depth,
    effective_date: ctx.effectiveDate,
    is_current: false,
    superseded_date: ctx.supersededDate,
    section_title: item.heading ?? null,
    content: plainContent,
    content_hash: newHash,
  });

  if (insertErr?.code === "23505") {
    console.warn(
      `[municode-history] duplicate snapshot skipped: ${identity.nodeId} (${ctx.effectiveDate})`,
    );
    return;
  }
  if (insertErr) {
    throw new Error(
      `Historical Municode provision insert failed for ${identity.nodeId}: ${insertErr.message}`,
    );
  }

  console.log(
    `[municode-history] inserted ${identity.nodeId} (${identity.strategy}, ${ctx.effectiveDate})`,
  );
  await persistHistoricalEmbedding(ctx, provisionId, plainContent);
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
      if (ctx.mode === "historical") {
        await upsertHistoricalProvision(
          item,
          ctx as HistoricalIngestContext,
          plainContent,
        );
      } else {
        await upsertProvision(item, ctx, plainContent);
      }
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
        mode: ctx.mode ?? "current",
        jobId: ctx.jobId,
        effectiveDate: ctx.effectiveDate,
        queue,
      };
      if (ctx.mode === "historical") {
        state.historicalJob = (ctx as HistoricalIngestContext).job;
      }
      const { error: persistErr } = await db
        .from("documents")
        .update({
          municode_resume_state: state,
          // Release the claim lease immediately (rather than waiting out the
          // lease window) so the next invocation's findResumableDocument()
          // can reclaim this document right away instead of stalling.
          resume_claim_expires_at: null,
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
        resume_claim_expires_at: null,
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

/** Minutes an exclusive resume-claim lease is held before it's considered stale. */
const RESUME_LEASE_MINUTES = 5;

type ResumableLookup =
  | { kind: "claimed"; documentId: string; state: ResumeState }
  | { kind: "leased"; documentId: string }
  | { kind: "none" };

/**
 * Finds an in-progress Municode document (soft-deadline-paused mid-walk) to
 * resume, if any, and atomically claims exclusive ownership of it via a
 * single conditional UPDATE ... WHERE ... RETURNING (not read-then-write).
 *
 * Two concurrent ingest-orchestrator invocations (plausible given overlapping
 * pending_ingestions triggers from the watchdog) can both reach the initial
 * SELECT and see the same candidate row, but only one's claim UPDATE will
 * affect a row — Postgres serializes concurrent UPDATEs on the same row, and
 * the WHERE guard re-checks lease eligibility at UPDATE time, so the loser's
 * UPDATE matches zero rows. The loser must NOT start a fresh job (that would
 * duplicate the resumed walk); it reports "leased" so the caller requeues
 * without doing any work this invocation.
 */
async function findResumableDocument(): Promise<ResumableLookup> {
  const { data: candidates, error: findErr } = await db
    .from("documents")
    .select("id, municode_resume_state")
    .eq("doc_type", "municode_api")
    .eq("status", "unknown")
    .not("municode_resume_state", "is", null)
    .order("ingested_at", { ascending: true })
    .limit(10);

  if (findErr) {
    throw new Error(
      `Municode resumable-document lookup failed: ${findErr.message}`,
    );
  }
  const candidate = (candidates ?? []).find((row) => {
    const state = row.municode_resume_state as ResumeState | null;
    return state?.mode !== "historical";
  });
  if (!candidate) return { kind: "none" };

  const nowIso = new Date().toISOString();
  const leaseExpiresAt = new Date(
    Date.now() + RESUME_LEASE_MINUTES * 60 * 1000,
  ).toISOString();

  const { data: claimed, error: claimErr } = await db
    .from("documents")
    .update({ resume_claim_expires_at: leaseExpiresAt })
    .eq("id", candidate.id)
    .not("municode_resume_state", "is", null)
    .or(`resume_claim_expires_at.is.null,resume_claim_expires_at.lt.${nowIso}`)
    .select("id, municode_resume_state")
    .maybeSingle();

  if (claimErr) {
    throw new Error(
      `Municode resume-claim update failed: ${claimErr.message}`,
    );
  }
  if (!claimed) {
    // Someone else holds an unexpired lease on this document right now.
    return { kind: "leased", documentId: candidate.id as string };
  }

  return {
    kind: "claimed",
    documentId: claimed.id as string,
    state: claimed.municode_resume_state as ResumeState,
  };
}

async function fetchProductJobs(
  baseUrl: string,
  userAgent: string,
): Promise<MunicodeJobSummary[]> {
  const jobs = await fetchJson(
    `${baseUrl}/Jobs/product/${PRODUCT_ID}`,
    userAgent,
  );
  if (!Array.isArray(jobs)) {
    throw new Error("Municode /Jobs/product response was not an array");
  }
  return jobs as MunicodeJobSummary[];
}

function latestJobFromProductJobs(
  jobs: MunicodeJobSummary[],
): SelectedHistoricalJob {
  const selected = selectHistoricalJobs(
    jobs,
    "",
    jobs.map((job) => {
      const match = (job.Name ?? "").match(/\bSupplement\s+(\d+)\b/i);
      return match ? Number(match[1]) : -1;
    }).filter((n) => n >= 0),
  );
  const latest = selected.at(-1);
  if (!latest) {
    throw new Error("Municode product jobs did not include any supplements");
  }
  return latest;
}

function nextOnlineDateAfter(
  jobs: MunicodeJobSummary[],
  job: SelectedHistoricalJob,
): string | null {
  const ordered = selectHistoricalJobs(
    jobs,
    "",
    jobs.map((candidate) => {
      const match = (candidate.Name ?? "").match(/\bSupplement\s+(\d+)\b/i);
      return match ? Number(match[1]) : -1;
    }).filter((n) => n >= 0),
  );
  const idx = ordered.findIndex((candidate) => candidate.jobId === job.jobId);
  return idx >= 0 ? ordered[idx + 1]?.onlineDate ?? null : null;
}

function prioritizeHistoricalJobs(
  jobs: SelectedHistoricalJob[],
): SelectedHistoricalJob[] {
  const priority = [
    156,
    157,
    155,
    158,
    159,
    160,
    126,
    127,
    128,
    129,
    130,
    176,
    177,
    178,
  ];
  return [...jobs].sort((a, b) => {
    const ai = priority.indexOf(a.supplementNumber);
    const bi = priority.indexOf(b.supplementNumber);
    const arank = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
    const brank = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
    if (arank !== brank) return arank - brank;
    return a.onlineDate.localeCompare(b.onlineDate);
  });
}

async function loadCurrentIdentityIndex(): Promise<CurrentIdentityIndex> {
  const { data: rows, error } = await db
    .from("ordinance_provisions")
    .select("municode_node_id, section_title, content")
    .eq("is_current", true);
  if (error) {
    throw new Error(
      `Current Municode identity index lookup failed: ${error.message}`,
    );
  }
  return buildCurrentIdentityIndex(
    (rows ?? []).map((row) => ({
      municode_node_id: row.municode_node_id as string,
      section_title: row.section_title as string | null,
      content: row.content as string | null,
    })),
  );
}

async function alignCurrentDocumentDate(
  baseUrl: string,
  latestJob: SelectedHistoricalJob,
): Promise<void> {
  const canonicalUrl =
    `${baseUrl}/CodesContent?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${latestJob.jobId}`;
  const { data: doc, error: lookupErr } = await db
    .from("documents")
    .select("id, source_published_at")
    .eq("url", canonicalUrl)
    .maybeSingle();
  if (lookupErr) {
    throw new Error(
      `Current Municode document lookup failed: ${lookupErr.message}`,
    );
  }
  if (!doc) return;

  const { error: docErr } = await db
    .from("documents")
    .update({
      source_published_at: latestJob.onlineDate,
      title: `Fairfax County Code of Ordinances — ${latestJob.name}`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", doc.id as string);
  if (docErr) {
    throw new Error(
      `Current Municode document date update failed: ${docErr.message}`,
    );
  }

  const { error: provisionErr } = await db
    .from("ordinance_provisions")
    .update({
      effective_date: latestJob.onlineDate,
      updated_at: new Date().toISOString(),
    })
    .eq("document_id", doc.id as string)
    .eq("is_current", true)
    .neq("effective_date", latestJob.onlineDate);
  if (provisionErr) {
    throw new Error(
      `Current Municode provision date update failed: ${provisionErr.message}`,
    );
  }
}

type HistoricalClaim =
  | { kind: "claimed"; documentId: string }
  | { kind: "already-complete"; documentId: string }
  | { kind: "leased"; documentId: string };

async function claimOrCreateHistoricalDocument(
  baseUrl: string,
  job: SelectedHistoricalJob,
  tocHash: string,
  rootNodes: TocNode[],
): Promise<HistoricalClaim> {
  const canonicalUrl =
    `${baseUrl}/CodesContent?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${job.jobId}`;

  const { data: existing, error: lookupErr } = await db
    .from("documents")
    .select("id, status, municode_resume_state")
    .eq("url", canonicalUrl)
    .maybeSingle();
  if (lookupErr) {
    throw new Error(`Historical document lookup failed: ${lookupErr.message}`);
  }

  if (!existing) {
    const now = new Date().toISOString();
    const documentId = uuidv7();
    const leaseExpiresAt = new Date(
      Date.now() + RESUME_LEASE_MINUTES * 60 * 1000,
    ).toISOString();
    const { error: insertErr } = await db.from("documents").insert({
      id: documentId,
      url: canonicalUrl,
      filename: null,
      doc_type: "municode_api",
      status: "unknown",
      ingested_at: now,
      last_checked_at: now,
      content_hash: tocHash,
      source_published_at: job.onlineDate,
      title: `Fairfax County Code of Ordinances — ${job.name}`,
      fiscal_year: null,
      docling_version: null,
      resume_claim_expires_at: leaseExpiresAt,
      raw_api_response: {
        historical_backfill: true,
        jobId: job.jobId,
        supplement: job.supplementNumber,
        selected_roots: rootNodes.map((node) => ({
          id: node.Id,
          heading: node.Heading,
        })),
      },
    });
    if (insertErr?.code === "23505") {
      return { kind: "leased", documentId };
    }
    if (insertErr) {
      throw new Error(
        `Historical Municode document insert failed: ${insertErr.message}`,
      );
    }
    return { kind: "claimed", documentId };
  }

  if (existing.status !== "unknown") {
    return {
      kind: "already-complete",
      documentId: existing.id as string,
    };
  }

  const nowIso = new Date().toISOString();
  const leaseExpiresAt = new Date(
    Date.now() + RESUME_LEASE_MINUTES * 60 * 1000,
  ).toISOString();
  const { data: claimed, error: claimErr } = await db
    .from("documents")
    .update({ resume_claim_expires_at: leaseExpiresAt })
    .eq("id", existing.id as string)
    .or(`resume_claim_expires_at.is.null,resume_claim_expires_at.lt.${nowIso}`)
    .select("id")
    .maybeSingle();
  if (claimErr) {
    throw new Error(`Historical document claim failed: ${claimErr.message}`);
  }
  if (!claimed) {
    return { kind: "leased", documentId: existing.id as string };
  }
  return { kind: "claimed", documentId: existing.id as string };
}

type HistoricalResumableLookup =
  | { kind: "claimed"; documentId: string; state: ResumeState }
  | { kind: "leased"; documentId: string }
  | { kind: "none" };

async function findResumableHistoricalDocument(): Promise<
  HistoricalResumableLookup
> {
  const { data: candidates, error: findErr } = await db
    .from("documents")
    .select("id, municode_resume_state")
    .eq("doc_type", "municode_api")
    .eq("status", "unknown")
    .not("municode_resume_state", "is", null)
    .order("ingested_at", { ascending: true })
    .limit(10);
  if (findErr) {
    throw new Error(
      `Historical Municode resumable-document lookup failed: ${findErr.message}`,
    );
  }

  const candidate = (candidates ?? []).find((row) => {
    const state = row.municode_resume_state as ResumeState | null;
    return state?.mode === "historical";
  });
  if (!candidate) return { kind: "none" };

  const nowIso = new Date().toISOString();
  const leaseExpiresAt = new Date(
    Date.now() + RESUME_LEASE_MINUTES * 60 * 1000,
  ).toISOString();

  const { data: claimed, error: claimErr } = await db
    .from("documents")
    .update({ resume_claim_expires_at: leaseExpiresAt })
    .eq("id", candidate.id as string)
    .not("municode_resume_state", "is", null)
    .or(`resume_claim_expires_at.is.null,resume_claim_expires_at.lt.${nowIso}`)
    .select("id, municode_resume_state")
    .maybeSingle();
  if (claimErr) {
    throw new Error(
      `Historical Municode resume claim failed: ${claimErr.message}`,
    );
  }
  if (!claimed) return { kind: "leased", documentId: candidate.id as string };
  return {
    kind: "claimed",
    documentId: claimed.id as string,
    state: claimed.municode_resume_state as ResumeState,
  };
}

async function finalizeHistoricalDocument(documentId: string): Promise<void> {
  const { error } = await db
    .from("documents")
    .update({
      status: "superseded",
      municode_resume_state: null,
      resume_claim_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId);
  if (error) {
    throw new Error(
      `Historical Municode document finalization failed: ${error.message}`,
    );
  }
}

interface HistoricalEmbeddingRow {
  id: string;
  content: string;
  historical_embedding_attempts?: number | null;
}

export interface MunicodeHistoricalEmbeddingRetryResult {
  processed: number;
  scheduled: number;
  complete: boolean;
  reason?: string;
}

function historicalEmbeddingDueFilter(nowIso: string): string {
  return `historical_embedding_next_attempt_at.is.null,historical_embedding_next_attempt_at.lte.${nowIso}`;
}

async function markHistoricalEmbeddingRetry(
  row: Pick<HistoricalEmbeddingRow, "id" | "historical_embedding_attempts">,
  reason: string,
): Promise<void> {
  const retry = scheduleHistoricalEmbeddingRetry(
    row.historical_embedding_attempts,
    reason,
  );
  const { error } = await db
    .from("ordinance_provisions")
    .update({
      historical_embedding_attempts: retry.attempts,
      historical_embedding_next_attempt_at: retry.nextAttemptAt,
      historical_embedding_last_error: retry.lastError,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) {
    throw new Error(
      `Historical embedding retry scheduling failed for ${row.id}: ${error.message}`,
    );
  }
}

async function persistHistoricalEmbeddingRetrySuccess(
  rowId: string,
  embedding: number[],
): Promise<void> {
  const { error } = await db
    .from("ordinance_provisions")
    .update({
      embedding,
      historical_embedding_next_attempt_at: null,
      historical_embedding_last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", rowId);
  if (error) {
    throw new Error(
      `Historical embedding retry update failed for ${rowId}: ${error.message}`,
    );
  }
}

async function fetchHistoricalEmbeddingBacklogRows(
  documentId: string | null,
  limit: number,
  respectRetrySchedule: boolean,
): Promise<HistoricalEmbeddingRow[]> {
  let query = db
    .from("ordinance_provisions")
    .select("id, content, historical_embedding_attempts")
    .eq("is_current", false)
    .is("embedding", null);

  if (documentId) {
    query = query.eq("document_id", documentId);
  }
  if (respectRetrySchedule) {
    query = query.or(historicalEmbeddingDueFilter(new Date().toISOString()));
  }

  const { data: rows, error: fetchErr } = await query
    .order("historical_embedding_next_attempt_at", {
      ascending: true,
      nullsFirst: true,
    })
    .order("id")
    .limit(limit);
  if (fetchErr) {
    throw new Error(
      `Historical embedding backlog lookup failed: ${fetchErr.message}`,
    );
  }
  return (rows ?? []) as HistoricalEmbeddingRow[];
}

async function countHistoricalEmbeddingBacklog(
  documentId: string | null,
  respectRetrySchedule: boolean,
): Promise<number> {
  let query = db
    .from("ordinance_provisions")
    .select("id", { count: "exact", head: true })
    .eq("is_current", false)
    .is("embedding", null);

  if (documentId) {
    query = query.eq("document_id", documentId);
  }
  if (respectRetrySchedule) {
    query = query.or(historicalEmbeddingDueFilter(new Date().toISOString()));
  }

  const { count, error } = await query;
  if (error) {
    throw new Error(
      `Historical embedding backlog count failed: ${error.message}`,
    );
  }
  return count ?? 0;
}

async function embedMissingHistoricalProvisions(
  documentId: string,
  embedUrl: string | null,
  deadlineMs?: number,
  respectRetrySchedule = false,
): Promise<{ processed: number; complete: boolean }> {
  if (!embedUrl) {
    const rows = await fetchHistoricalEmbeddingBacklogRows(
      documentId,
      25,
      respectRetrySchedule,
    );
    for (const row of rows) {
      await markHistoricalEmbeddingRetry(row, "embed_url_unavailable");
    }
    const remaining = await countHistoricalEmbeddingBacklog(
      documentId,
      respectRetrySchedule,
    );
    return {
      processed: 0,
      complete: rows.length === 0 && remaining === 0,
    };
  }

  let processed = 0;
  while (true) {
    if (
      deadlineMs !== undefined && Date.now() >= deadlineMs - DEADLINE_BUFFER_MS
    ) {
      return { processed, complete: false };
    }

    const rows = await fetchHistoricalEmbeddingBacklogRows(
      documentId,
      5,
      respectRetrySchedule,
    );
    if (rows.length === 0) {
      return { processed, complete: true };
    }

    for (const row of rows) {
      if (
        deadlineMs !== undefined &&
        Date.now() >= deadlineMs - DEADLINE_BUFFER_MS
      ) {
        return { processed, complete: false };
      }
      const [embedding] = await generateEmbeddingsHttp(
        embedUrl,
        [row.content],
      );
      if (!embedding) {
        console.warn(
          `[municode-history] null embedding while retrying historical provision ${row.id}`,
        );
        await markHistoricalEmbeddingRetry(row, "embed_generation_failed");
        return { processed, complete: false };
      }
      await persistHistoricalEmbeddingRetrySuccess(row.id, embedding);
      processed += 1;
    }
  }
}

export async function handleMunicodeHistoricalEmbeddingRetry(
  deadlineMs?: number,
): Promise<MunicodeHistoricalEmbeddingRetryResult> {
  const dueCount = await countHistoricalEmbeddingBacklog(null, true);
  if (dueCount === 0) {
    return { processed: 0, scheduled: 0, complete: true };
  }

  const embedUrl = await availableHistoricalEmbedUrl(
    Deno.env.get("HF_SPACES_DOCLING_URL") ?? null,
  );

  let processed = 0;
  let scheduled = 0;

  if (!embedUrl) {
    const rows = await fetchHistoricalEmbeddingBacklogRows(null, 25, true);
    for (const row of rows) {
      await markHistoricalEmbeddingRetry(row, "embed_url_unavailable");
      scheduled += 1;
    }
    return {
      processed,
      scheduled,
      complete: rows.length === 0,
      reason: rows.length === 0 ? undefined : "embed_url_unavailable",
    };
  }

  while (true) {
    if (
      deadlineMs !== undefined && Date.now() >= deadlineMs - DEADLINE_BUFFER_MS
    ) {
      return {
        processed,
        scheduled,
        complete: false,
        reason: "soft_deadline",
      };
    }

    const rows = await fetchHistoricalEmbeddingBacklogRows(null, 5, true);
    if (rows.length === 0) {
      return { processed, scheduled, complete: true };
    }

    for (const row of rows) {
      if (
        deadlineMs !== undefined &&
        Date.now() >= deadlineMs - DEADLINE_BUFFER_MS
      ) {
        return {
          processed,
          scheduled,
          complete: false,
          reason: "soft_deadline",
        };
      }
      const [embedding] = await generateEmbeddingsHttp(embedUrl, [row.content]);
      if (!embedding) {
        await markHistoricalEmbeddingRetry(row, "embed_generation_failed");
        scheduled += 1;
        return {
          processed,
          scheduled,
          complete: false,
          reason: "embed_generation_failed",
        };
      }
      await persistHistoricalEmbeddingRetrySuccess(row.id, embedding);
      processed += 1;
    }
  }
}

async function fetchTocForJob(
  baseUrl: string,
  userAgent: string,
  jobId: string,
): Promise<TocNode> {
  const tocUrl =
    `${baseUrl}/codesToc?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${jobId}`;
  const tocPayload = await fetchJson(tocUrl, userAgent) as TocNode;
  if (
    typeof tocPayload !== "object" || tocPayload === null ||
    !Array.isArray(tocPayload.Children)
  ) {
    throw new Error(
      `Municode codesToc response missing Children for historical job ${jobId}`,
    );
  }
  return tocPayload;
}

function isChapter4(heading: string | null | undefined): boolean {
  return /^chapter\s+4(?:\b|\.)/i.test((heading ?? "").trim());
}

function isArticle6UtilityTax(heading: string | null | undefined): boolean {
  const normalized = (heading ?? "").trim().toLowerCase();
  return normalized.startsWith("article 6") &&
    (normalized.includes("utility") || normalized.includes("ut"));
}

async function selectHistoricalRootNodes(
  baseUrl: string,
  userAgent: string,
  jobId: string,
  chapterNodes: TocNode[],
): Promise<TocNode[]> {
  const roots: TocNode[] = [];
  for (const node of chapterNodes) {
    if (isChapter4(node.Heading)) {
      await sleep(SUBSECTION_DELAY_MS);
      const children = await fetchNodeChildren(
        baseUrl,
        jobId,
        node.Id,
        userAgent,
      );
      roots.push(
        ...children.filter((child) => isArticle6UtilityTax(child.Heading)),
      );
      continue;
    }
    if (
      headingMatchesHistoricalChapter(node.Heading, [
        "Chapter 9.1",
        "Chapter 9.2",
      ])
    ) {
      roots.push(node);
    }
  }
  return roots;
}

export interface MunicodeHistoricalBackfillResult {
  complete: boolean;
  selectedSupplements: number[];
  selectedChapterPrefixes: readonly string[];
  processedJobs: Array<{
    jobId: string;
    supplement: number;
    onlineDate: string;
    documentId: string;
    status: "processed" | "skipped" | "resumed";
  }>;
  reason?: string;
}

export async function handleMunicodeHistoricalBackfill(
  deadlineMs?: number,
): Promise<MunicodeHistoricalBackfillResult> {
  const baseUrl = requireEnv("MUNICODE_BASE_URL");
  const userAgent = requireEnv("MUNICODE_USER_AGENT");
  const embedUrl = await availableHistoricalEmbedUrl(
    Deno.env.get("HF_SPACES_DOCLING_URL") ?? null,
  );

  const productJobs = await fetchProductJobs(baseUrl, userAgent);
  const latestJob = latestJobFromProductJobs(productJobs);
  const selectedJobs = prioritizeHistoricalJobs(
    selectHistoricalJobs(
      productJobs,
      latestJob.jobId,
      DEFAULT_HISTORICAL_SUPPLEMENTS,
    ),
  );
  await alignCurrentDocumentDate(baseUrl, latestJob);

  const selectedSupplements = selectedJobs.map((job) => job.supplementNumber);
  const processedJobs: MunicodeHistoricalBackfillResult["processedJobs"] = [];
  const identityIndex = await loadCurrentIdentityIndex();

  const resumable = await findResumableHistoricalDocument();
  if (resumable.kind === "leased") {
    return {
      complete: false,
      selectedSupplements,
      selectedChapterPrefixes: DEFAULT_HISTORICAL_CHAPTER_PREFIXES,
      processedJobs,
      reason: `historical resume lease held for ${resumable.documentId}`,
    };
  }
  if (resumable.kind === "claimed") {
    const job = resumable.state.historicalJob;
    if (!job) {
      throw new Error(
        `Historical resume state for ${resumable.documentId} is missing job metadata`,
      );
    }
    const ctx: HistoricalIngestContext = {
      mode: "historical",
      baseUrl,
      userAgent,
      jobId: job.jobId,
      documentId: resumable.documentId,
      effectiveDate: job.onlineDate,
      job,
      identityIndex,
      embedUrl,
      supersededDate: nextOnlineDateAfter(productJobs, job),
    };
    const result = await drainQueue(
      resumable.state.queue,
      ctx,
      deadlineMs,
      true,
    );
    if (!result.complete) {
      return {
        complete: false,
        selectedSupplements,
        selectedChapterPrefixes: DEFAULT_HISTORICAL_CHAPTER_PREFIXES,
        processedJobs,
        reason: `resumed ${job.name} hit soft deadline`,
      };
    }
    await finalizeHistoricalDocument(resumable.documentId);
    processedJobs.push({
      jobId: job.jobId,
      supplement: job.supplementNumber,
      onlineDate: job.onlineDate,
      documentId: resumable.documentId,
      status: "resumed",
    });
  }

  for (const job of selectedJobs) {
    if (
      deadlineMs !== undefined && Date.now() >= deadlineMs - DEADLINE_BUFFER_MS
    ) {
      return {
        complete: false,
        selectedSupplements,
        selectedChapterPrefixes: DEFAULT_HISTORICAL_CHAPTER_PREFIXES,
        processedJobs,
        reason: "soft deadline reached before next historical job",
      };
    }

    await sleep(REQUEST_DELAY_MS);
    const tocPayload = await fetchTocForJob(baseUrl, userAgent, job.jobId);
    const roots = await selectHistoricalRootNodes(
      baseUrl,
      userAgent,
      job.jobId,
      tocPayload.Children!,
    );
    if (roots.length === 0) {
      continue;
    }

    const tocHash = await contentHash(JSON.stringify({
      historicalBackfill: true,
      jobId: job.jobId,
      roots: roots.map((node) => node.Id),
    }));
    const claim = await claimOrCreateHistoricalDocument(
      baseUrl,
      job,
      tocHash,
      roots,
    );
    if (claim.kind === "leased") {
      return {
        complete: false,
        selectedSupplements,
        selectedChapterPrefixes: DEFAULT_HISTORICAL_CHAPTER_PREFIXES,
        processedJobs,
        reason: `historical document lease held for ${job.name}`,
      };
    }
    if (claim.kind === "already-complete") {
      const embedResult = await embedMissingHistoricalProvisions(
        claim.documentId,
        embedUrl,
        deadlineMs,
      );
      if (!embedResult.complete) {
        return {
          complete: false,
          selectedSupplements,
          selectedChapterPrefixes: DEFAULT_HISTORICAL_CHAPTER_PREFIXES,
          processedJobs,
          reason:
            `historical embedding backlog for ${job.name} hit soft deadline after ${embedResult.processed} row(s)`,
        };
      }
      processedJobs.push({
        jobId: job.jobId,
        supplement: job.supplementNumber,
        onlineDate: job.onlineDate,
        documentId: claim.documentId,
        status: "skipped",
      });
      continue;
    }

    const queue: QueueItem[] = [];
    pushChildren(queue, roots, tocPayload.Id ?? null, 1);
    const ctx: HistoricalIngestContext = {
      mode: "historical",
      baseUrl,
      userAgent,
      jobId: job.jobId,
      documentId: claim.documentId,
      effectiveDate: job.onlineDate,
      job,
      identityIndex,
      embedUrl,
      supersededDate: nextOnlineDateAfter(productJobs, job),
    };
    const result = await drainQueue(queue, ctx, deadlineMs, false);
    if (!result.complete) {
      return {
        complete: false,
        selectedSupplements,
        selectedChapterPrefixes: DEFAULT_HISTORICAL_CHAPTER_PREFIXES,
        processedJobs,
        reason: `${job.name} hit soft deadline`,
      };
    }
    await finalizeHistoricalDocument(claim.documentId);
    processedJobs.push({
      jobId: job.jobId,
      supplement: job.supplementNumber,
      onlineDate: job.onlineDate,
      documentId: claim.documentId,
      status: "processed",
    });
  }

  return {
    complete: true,
    selectedSupplements,
    selectedChapterPrefixes: DEFAULT_HISTORICAL_CHAPTER_PREFIXES,
    processedJobs,
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
  if (resumable.kind === "leased") {
    // Another invocation holds the exclusive claim on this paused document
    // right now. Do NOT start a fresh job (that would duplicate the resumed
    // walk) — just requeue so this invocation retries shortly without doing
    // any work.
    console.log(
      `[municode] resume lease held by another invocation for document ${resumable.documentId} — requeueing`,
    );
    return {
      documentId: resumable.documentId,
      nodeIds: [],
      skipped: false,
      complete: false,
    };
  }
  if (resumable.kind === "claimed") {
    console.log(
      `[municode] resuming in-progress walk for document ${resumable.documentId}`,
    );
    const ctx: IngestContext = {
      mode: "current",
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
  const effectiveDate = effectiveDateFromJob(jobPayload);
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
    const canonicalUrl =
      `${baseUrl}/CodesContent?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${jobId}`;

    // Orphan-recovery check: a document row may already exist at this URL
    // from a prior invocation that crashed after its walk fully drained but
    // before index.ts finished embedOrdinanceProvisions()/finalization (so
    // documents.status never flipped to 'current'). findResumableDocument()
    // above only catches documents with a non-null municode_resume_state, so
    // this case falls through — without this check, every retry would hit
    // the plain insert below and fail forever on documents_url_key.
    const { data: orphan, error: orphanErr } = await db
      .from("documents")
      .select("id, status, municode_resume_state")
      .eq("url", canonicalUrl)
      .maybeSingle();
    if (orphanErr) {
      throw new Error(
        `Municode orphan-document lookup failed: ${orphanErr.message}`,
      );
    }

    let provisionCount = 0;
    if (orphan) {
      const { count, error: countErr } = await db
        .from("ordinance_provisions")
        .select("id", { count: "exact", head: true })
        .eq("document_id", orphan.id as string);
      if (countErr) {
        throw new Error(
          `Orphan provision-count check failed for document ${orphan.id}: ${countErr.message}`,
        );
      }
      provisionCount = count ?? 0;
    }

    const action = classifyOrphanRecovery(
      orphan
        ? {
          status: orphan.status as string,
          municode_resume_state: orphan.municode_resume_state,
        }
        : null,
      provisionCount,
    );

    if (action === "finalize-only" || action === "rewalk-from-root") {
      // Atomically claim the orphaned document row before acting on it, via
      // the same conditional UPDATE ... WHERE ... RETURNING pattern (not
      // read-then-write) findResumableDocument() uses for the resume-state
      // lease above, reusing the same resume_claim_expires_at column. Two
      // concurrent ingest-orchestrator invocations (plausible given
      // overlapping pending_ingestions triggers from the watchdog) can both
      // reach the SELECT above and see the same orphan snapshot, but only
      // one's claim UPDATE will affect a row — Postgres serializes
      // concurrent UPDATEs on the same row, and the WHERE guard re-checks
      // lease eligibility (and that the row hasn't meanwhile entered an
      // active resume-state walk) at UPDATE time, so the loser's UPDATE
      // matches zero rows. The loser must NOT proceed to finalize or
      // re-walk (that would duplicate the work); it requeues without doing
      // any work this invocation.
      const nowIso = new Date().toISOString();
      const leaseExpiresAt = new Date(
        Date.now() + RESUME_LEASE_MINUTES * 60 * 1000,
      ).toISOString();

      const { data: claimedOrphan, error: claimOrphanErr } = await db
        .from("documents")
        .update({ resume_claim_expires_at: leaseExpiresAt })
        .eq("id", orphan!.id as string)
        .is("municode_resume_state", null)
        .or(
          `resume_claim_expires_at.is.null,resume_claim_expires_at.lt.${nowIso}`,
        )
        .select("id")
        .maybeSingle();

      if (claimOrphanErr) {
        throw new Error(
          `Orphan-recovery claim update failed for document ${
            orphan!.id
          }: ${claimOrphanErr.message}`,
        );
      }
      if (!claimedOrphan) {
        // Someone else holds an unexpired claim on this document right now.
        console.log(
          `[municode] orphan-recovery claim held by another invocation for document ${
            orphan!.id
          } — requeueing`,
        );
        return {
          documentId: orphan!.id as string,
          nodeIds: [],
          skipped: false,
          complete: false,
        };
      }
    }

    if (action === "finalize-only") {
      // Walk already fully drained by a prior invocation — only the
      // finalization step (embedding + status flip, owned by index.ts)
      // never ran. Skip straight to that instead of re-walking or
      // re-inserting a duplicate document row.
      documentId = orphan!.id as string;
      console.log(
        `[municode] recovering orphaned document ${documentId} — walk already drained (${provisionCount} provisions), skipping to finalization`,
      );
      const { data: rows, error: nodeIdsErr } = await db
        .from("ordinance_provisions")
        .select("municode_node_id")
        .eq("document_id", documentId);
      if (nodeIdsErr) {
        throw new Error(
          `Failed to read back ordinance_provisions node ids for orphan recovery: ${nodeIdsErr.message}`,
        );
      }
      return {
        documentId,
        nodeIds: (rows ?? []).map((r) => r.municode_node_id as string),
        skipped: false,
        complete: true,
      };
    } else if (action === "rewalk-from-root") {
      // Prior attempt crashed before any walk progress was made. Reuse the
      // existing shell rather than inserting a second row at the same URL.
      documentId = orphan!.id as string;
      console.log(
        `[municode] recovering orphaned document ${documentId} — no provisions written yet, re-walking from root`,
      );
    } else {
      // 4. Create Document shell row at status='unknown'
      const now = new Date().toISOString();
      documentId = uuidv7();

      const { error: docErr } = await db.from("documents").insert({
        id: documentId,
        url: canonicalUrl,
        filename: null,
        doc_type: "municode_api",
        status: "unknown",
        ingested_at: now,
        last_checked_at: now,
        content_hash: hash,
        source_published_at: effectiveDate,
        title: `Fairfax County Code of Ordinances — ${
          String(jobPayload?.Name ?? `Supplement ${jobId}`)
        }`,
        fiscal_year: null,
        docling_version: null,
        raw_api_response: { jobId, toc_node_count: chapterNodes.length },
      });

      if (docErr) {
        throw new Error(`Municode document insert failed: ${docErr.message}`);
      }
      console.log(`[municode] document shell created: ${documentId}`);
    }
  }

  // 5. Iteratively walk all nodes at all depths (LIFO stack — DFS pre-order,
  // matching the original recursive visiting order).
  const queue: QueueItem[] = [];
  pushChildren(queue, chapterNodes, rootId, 1);

  const ctx: IngestContext = {
    mode: "current",
    baseUrl,
    userAgent,
    jobId,
    documentId,
    effectiveDate,
  };
  return await drainQueue(queue, ctx, deadlineMs, false);
}
