/**
 * EnCode zoning-ordinance ingestion handler (encode_zoning doc_type).
 *
 * WHY THIS EXISTS: Fairfax County's Zoning Ordinance (Chapter 112.2) is not
 * on Municode -- product 10051's TOC jumps from Chapter 110 straight to
 * Chapter 113. Zoning is published on a separate codification platform,
 * EnCode (https://online.encodeplus.com/regs/fairfaxcounty-va/), confirmed
 * via Fairfax County's own zoning page (fairfaxcounty.gov/planning-development/
 * zoning-ordinance), which links directly to it. This blocks every eval case
 * that needs setbacks, FAR, lot size, ADU square footage, home occupation
 * rules, or parking requirements -- all live under this ordinance.
 *
 * COMPLIANCE NOTE (read before enabling a recurring cron trigger): EnCode's
 * robots.txt disallows "/regs/" for `User-agent: *` -- it explicitly
 * allowlists only Googlebot/msnbot/bingbot. Every endpoint this file calls
 * lives under /regs/fairfaxcounty-va/. This is a real, deliberate exclusion,
 * not an oversight -- flagged here and in the PR description for human/legal
 * sign-off before this source runs on an unattended recurring schedule. The
 * fetch calls below self-identify via ENCODE_USER_AGENT (never spoof
 * Googlebot) and share the same conservative delay budget as the Municode
 * and Fairfax fetchers.
 *
 * API SHAPE (no JSON API -- HTML-fragment scraping; see _encode-helpers.ts
 * for the parsing detail):
 *
 *   1. GET toc-view.aspx?tocid=<dotted-path>&task=expand
 *        Root: tocid="001" (secid "2214", "Fairfax County Zoning Ordinance"
 *        -- confirmed stable via manual site inspection, hardcoded the same
 *        way municode.ts hardcodes PRODUCT_ID/CLIENT_ID). Returns the node's
 *        direct children (secid, dotted child-tocid if expandable, heading).
 *
 *   2. GET doc-view.aspx?ajax=0&secid=<N>
 *        Returns that node's own body text.
 *
 * VERSION SIGNAL: EnCode exposes no per-run "job id" the way Municode's
 * /Jobs/latest does. Its closest analog is the "Amendment History Table"
 * (secid 3044, a direct root child, hardcoded as AMENDMENT_HISTORY_SECID) --
 * a single page listing every amendment since the May 2023 readoption
 * (number, adoption/effective dates, affected sections, description). Its
 * content is fetched and hashed FIRST, before the walk, and used exactly
 * like Municode's TOC-body hash: an existing status='current' document with
 * the same hash means nothing has changed since the last successful run, so
 * the whole walk is skipped. A newly-adopted amendment changes this table's
 * text (a new row) even when it doesn't add/remove a whole Article, so this
 * is a better change signal here than an Article-list hash would be.
 * AMENDMENT_HISTORY_SECID is also walked and ingested as a normal provision
 * like every other node, so its (quotable) text is queryable too.
 *
 * HISTORICAL VERSIONS -- FLAGGED FOR POLLY, NOT IMPLEMENTED HERE: the
 * Amendment History Table gives amendment metadata (what changed, when,
 * which sections) but EnCode does not expose distinct historical secids for
 * prior section text -- there is no way to fetch "what subsection 5100.2.Q
 * said before the 2023 Parking Reimagined amendment" from this site. Live
 * per-node supersession (is_current flip on content_hash change, exactly
 * mirroring municode.ts's upsertProvision) still applies going forward: the
 * next time this ordinance changes, the old text is preserved as
 * is_current=false with a superseded_date. But there is no backfill path for
 * pre-ingestion history. A possible follow-up: parse the Amendment History
 * Table's rows into a structured table (amendment number/dates/affected
 * sections) instead of only ingesting it as unstructured provision text, so
 * "when was section X last amended" is a direct lookup rather than relying
 * on the LLM to parse it out of prose.
 *
 * Everything else mirrors municode.ts's proven shape: deadline-aware
 * resumable iterative (not recursive) walk, per-node content_hash
 * supersession, concurrent-invocation-safe resume claim, and orphan
 * recovery for a walk that drained but crashed before finalization. Does
 * NOT set documents.status or generate embeddings -- index.ts (task 2-6)
 * owns that, via the same embedOrdinanceProvisionsBatched used for Municode.
 *
 * COMPLIANCE GATE: per the COMPLIANCE NOTE above, this source must not make
 * a single request against the robots.txt-disallowed /regs/ path on an
 * unattended schedule without human/legal sign-off. handleEncode() checks
 * ENCODE_ZONING_ENABLED before any network or lookup call and skips the
 * ingestion (no fetch, no DB writes beyond marking the row skipped) unless
 * it is exactly "true". Both the pg_cron poll path and an explicit
 * pending_ingestion_id call are covered, since both funnel through this
 * function. Set the secret to "true" only after that sign-off.
 */

import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { contentHash } from "../_shared/hash.ts";
import {
  classifyOrphanRecovery,
  type EncodeTocChild,
  extractSectionText,
  extractTocChildren,
} from "./_encode-helpers.ts";

const ROOT_TOCID = "001";
const ROOT_SECID = "2214";
/** "Amendment History Table" -- direct root child, used as the change-detection version signal. */
const AMENDMENT_HISTORY_SECID = "3044";

/** Node ids stored in the shared ordinance_provisions.municode_node_id column are namespaced to avoid colliding with real Municode node ids. */
const NODE_ID_PREFIX = "encode:";

/**
 * Polite delay between requests. EnCode's robots.txt disallows "/regs/" for
 * generic crawlers (see file header) -- this stays at least as conservative
 * as the Fairfax discovery-crawler's 200ms limiter, not tuned down for
 * throughput.
 */
const REQUEST_DELAY_MS = 300;
const SUBSECTION_DELAY_MS = 200;
/** Buffer before the soft deadline at which the walk pauses and persists resume state. */
const DEADLINE_BUFFER_MS = 20_000; // matches municode.ts / extractor.ts

interface QueueItem {
  secid: string;
  /** Dotted path needed to expand this node's own children; null once known to be a leaf. */
  tocid: string | null;
  heading: string;
  hasChildren: boolean;
  parentSecid: string | null;
  depth: number;
}

interface ResumeState {
  effectiveDate: string;
  queue: QueueItem[];
}

interface IngestContext {
  baseUrl: string;
  userAgent: string;
  documentId: string;
  effectiveDate: string;
}

/** Default base URL/user agent, used when ENCODE_BASE_URL/ENCODE_USER_AGENT aren't set as secrets -- neither is sensitive (a public site root and a self-identifying string), so unlike SUPABASE_SERVICE_ROLE_KEY-style secrets a literal fallback is safe. Mirrors change-detection/index.ts's userAgent() DEFAULT_USER_AGENT fallback for the same reason. Still overridable via env var. */
const DEFAULT_ENCODE_BASE_URL =
  "https://online.encodeplus.com/regs/fairfaxcounty-va";
const DEFAULT_ENCODE_USER_AGENT =
  "PolicyNavigator/1.0 encode-zoning-ingestion (contact: danielleag30@gmail.com)";

function envOrDefault(name: string, fallback: string): string {
  return Deno.env.get(name) ?? fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url: string, userAgent: string): Promise<string> {
  const resp = await fetch(url, { headers: { "User-Agent": userAgent } });
  if (!resp.ok) {
    throw new Error(`EnCode HTTP ${resp.status} at ${url}`);
  }
  return resp.text();
}

/** default effective_date = today + 1 day (ISO date string) -- matches municode.ts. */
function defaultEffectiveDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function fetchTocChildren(
  baseUrl: string,
  parentSecid: string,
  childTocid: string,
  userAgent: string,
): Promise<EncodeTocChild[]> {
  const url = `${baseUrl}/toc-view.aspx?tocid=${childTocid}&task=expand`;
  const html = await fetchHtml(url, userAgent);
  return extractTocChildren(html, parentSecid);
}

async function fetchSectionContent(
  baseUrl: string,
  secid: string,
  userAgent: string,
): Promise<string> {
  const url = `${baseUrl}/doc-view.aspx?ajax=0&secid=${secid}`;
  const html = await fetchHtml(url, userAgent);
  return extractSectionText(html, secid);
}

/**
 * Insert a node's content as an ordinance_provisions row, applying the same
 * per-node supersession as municode.ts's upsertProvision: unchanged content
 * vs. an existing is_current row is skipped; genuinely different content
 * flips the old row to is_current=false (with superseded_date) before
 * inserting the new one. The WHERE is_current=true guard on the supersede
 * UPDATE plus the ordinance_provisions_one_current_per_node_idx partial
 * unique index give the same concurrent-invocation race safety documented
 * in municode.ts (a 23505 on insert means another process already won).
 */
async function upsertProvision(
  item: QueueItem,
  ctx: IngestContext,
  plainContent: string,
): Promise<void> {
  const nodeId = `${NODE_ID_PREFIX}${item.secid}`;
  const parentNodeId = item.parentSecid
    ? `${NODE_ID_PREFIX}${item.parentSecid}`
    : null;
  const newHash = await contentHash(plainContent);

  const { data: existing, error: lookupErr } = await db
    .from("ordinance_provisions")
    .select("id, content_hash")
    .eq("municode_node_id", nodeId)
    .eq("is_current", true)
    .maybeSingle();

  if (lookupErr) {
    throw new Error(
      `ordinance_provisions current-row lookup failed for ${nodeId}: ${lookupErr.message}`,
    );
  }

  if (existing && existing.content_hash === newHash) {
    console.log(
      `[encode] unchanged content — skipping ${nodeId} (depth ${item.depth})`,
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
      .eq("id", existing.id)
      .eq("is_current", true);
    if (supersedeErr) {
      throw new Error(
        `Failed to supersede prior ordinance_provisions row for ${nodeId}: ${supersedeErr.message}`,
      );
    }
    console.log(
      `[encode] superseded prior version of ${nodeId} (superseded_date=${ctx.effectiveDate})`,
    );
  }

  const { error: provErr } = await db.from("ordinance_provisions").insert({
    id: uuidv7(),
    document_id: ctx.documentId,
    municode_node_id: nodeId,
    parent_node_id: parentNodeId,
    depth: item.depth,
    effective_date: ctx.effectiveDate,
    is_current: true,
    section_title: item.heading ?? null,
    content: plainContent,
    content_hash: newHash,
    source_type: "encode_zoning",
  });

  if (provErr?.code === "23505") {
    console.warn(
      `[encode] duplicate provision skipped: ${nodeId} (depth ${item.depth})`,
    );
  } else if (provErr) {
    throw new Error(
      `EnCode provision insert failed for ${nodeId}: ${provErr.message}`,
    );
  }
}

interface ProcessNodeResult {
  children: EncodeTocChild[];
  /** True if the content fetch or the child-TOC fetch threw for this node. */
  failed: boolean;
}

/**
 * Fetch content for one queued node, upsert it, and return its children (if
 * any) so the caller can push them onto the walk stack. Mirrors
 * municode.ts's processNode: descent into children happens regardless of
 * whether the content insert was skipped as unchanged.
 *
 * Unlike municode.ts's processNode, a fetch failure here is reported back to
 * the caller via `failed` rather than only logged -- see drainQueue's
 * failure handling for why: a silently-truncated subtree must not let the
 * document finalize as status='current' with data missing.
 */
async function processNode(
  item: QueueItem,
  ctx: IngestContext,
): Promise<ProcessNodeResult> {
  let plainContent = "";
  let failed = false;
  try {
    plainContent = await fetchSectionContent(
      ctx.baseUrl,
      item.secid,
      ctx.userAgent,
    );
  } catch (e) {
    failed = true;
    console.warn(
      `[encode] content fetch failed for ${item.secid} (depth ${item.depth}): ${
        (e as Error).message
      }`,
    );
  }

  if (plainContent) {
    await upsertProvision(item, ctx, plainContent);
  } else if (!failed) {
    console.log(
      `[encode] skipping ${item.secid} (depth ${item.depth}) — empty content`,
    );
  }

  if (!item.hasChildren || !item.tocid) return { children: [], failed };

  await sleep(SUBSECTION_DELAY_MS);
  try {
    const children = await fetchTocChildren(
      ctx.baseUrl,
      item.secid,
      item.tocid,
      ctx.userAgent,
    );
    if (children.length > 0) {
      console.log(
        `[encode] depth ${
          item.depth + 1
        }: ${children.length} children of ${item.secid}`,
      );
    }
    return { children, failed };
  } catch (e) {
    console.warn(
      `[encode] children fetch failed for ${item.secid}: ${
        (e as Error).message
      }`,
    );
    return { children: [], failed: true };
  }
}

/** Push a node's children onto the LIFO stack in an order that preserves DFS pre-order visiting. */
function pushChildren(
  queue: QueueItem[],
  children: EncodeTocChild[],
  parentSecid: string,
  depth: number,
): void {
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    queue.push({
      secid: child.secid,
      tocid: child.tocid,
      heading: child.heading,
      hasChildren: child.hasChildren,
      parentSecid,
      depth,
    });
  }
}

export interface EncodeResult {
  documentId: string;
  nodeIds: string[];
  skipped: boolean;
  /** false when the soft deadline was hit mid-walk and a resume is needed on the next invocation. */
  complete: boolean;
}

/**
 * Persist the remaining walk stack to documents.encode_resume_state so a
 * later invocation can pick the walk back up from where it left off (mirrors
 * municode.ts's equivalent deadline-persist step).
 */
async function persistResumeState(
  queue: QueueItem[],
  ctx: IngestContext,
): Promise<void> {
  const state: ResumeState = { effectiveDate: ctx.effectiveDate, queue };
  const { error: persistErr } = await db
    .from("documents")
    .update({
      encode_resume_state: state,
      resume_claim_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ctx.documentId);
  if (persistErr) {
    throw new Error(
      `Failed to persist EnCode resume state: ${persistErr.message}`,
    );
  }
}

/**
 * Drain the walk stack, checking the soft deadline before each item. Mirrors
 * municode.ts's drainQueue (see that file for the full rationale), with one
 * addition: municode.ts's processNode swallows a per-node fetch failure
 * entirely (log + treat as childless), which lets an entire subtree silently
 * vanish while the document still finalizes as status='current' with data
 * missing. Here, a fetch failure persists the same resume state used for the
 * soft-deadline case (so no progress is lost) but then throws instead of
 * returning complete: true/false -- letting the failure propagate to
 * index.ts's normal catch-all error path (attempts++, backoff via
 * nextAttemptAt, eventual ABSOLUTE_MAX_ATTEMPTS skip). That path is
 * deliberately NOT the same as the deadline-resume return: requeueForResume
 * is attempt-neutral (decrements attempts back), which is correct for "ran
 * out of time" but would let a permanently-broken node retry forever against
 * a robots.txt-sensitive site if reused here for genuine fetch failures.
 */
async function drainQueue(
  queue: QueueItem[],
  ctx: IngestContext,
  deadlineMs: number | undefined,
  hadResumeState: boolean,
): Promise<EncodeResult> {
  while (queue.length > 0) {
    if (
      deadlineMs !== undefined && Date.now() >= deadlineMs - DEADLINE_BUFFER_MS
    ) {
      await persistResumeState(queue, ctx);
      console.warn(
        `[encode] soft deadline hit with ${queue.length} node(s) remaining; persisted resume state for document ${ctx.documentId}`,
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
    const { children, failed } = await processNode(item, ctx);

    if (failed) {
      queue.push(item);
      await persistResumeState(queue, ctx);
      throw new Error(
        `EnCode fetch failed for node ${item.secid} (depth ${item.depth}) -- ` +
          `resume state persisted for document ${ctx.documentId}; document will ` +
          `not finalize as current until this node succeeds`,
      );
    }

    if (children.length > 0) {
      pushChildren(queue, children, item.secid, item.depth + 1);
    }
  }

  if (hadResumeState) {
    const { error: clearErr } = await db
      .from("documents")
      .update({
        encode_resume_state: null,
        resume_claim_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", ctx.documentId);
    if (clearErr) {
      throw new Error(
        `Failed to clear EnCode resume state: ${clearErr.message}`,
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
    `[encode] walk complete: ${nodeIds.length} ordinance_provisions total for document ${ctx.documentId}`,
  );

  return {
    documentId: ctx.documentId,
    nodeIds,
    skipped: false,
    complete: true,
  };
}

/** Minutes an exclusive resume-claim lease is held before it's considered stale -- matches municode.ts. */
const RESUME_LEASE_MINUTES = 5;

type ResumableLookup =
  | { kind: "claimed"; documentId: string; state: ResumeState }
  | { kind: "leased"; documentId: string }
  | { kind: "none" };

/**
 * Finds an in-progress EnCode document to resume, if any, and atomically
 * claims exclusive ownership via a single conditional UPDATE ... WHERE ...
 * RETURNING -- mirrors municode.ts's findResumableDocument() (see that
 * file's CONCURRENCY section for the full race-condition rationale; the
 * same overlapping pending_ingestions-trigger hazard applies here).
 */
async function findResumableDocument(): Promise<ResumableLookup> {
  const { data: candidate, error: findErr } = await db
    .from("documents")
    .select("id")
    .eq("doc_type", "encode_zoning")
    .eq("status", "unknown")
    .not("encode_resume_state", "is", null)
    .order("ingested_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (findErr) {
    throw new Error(
      `EnCode resumable-document lookup failed: ${findErr.message}`,
    );
  }
  if (!candidate) return { kind: "none" };

  const nowIso = new Date().toISOString();
  const leaseExpiresAt = new Date(
    Date.now() + RESUME_LEASE_MINUTES * 60 * 1000,
  ).toISOString();

  const { data: claimed, error: claimErr } = await db
    .from("documents")
    .update({ resume_claim_expires_at: leaseExpiresAt })
    .eq("id", candidate.id)
    .not("encode_resume_state", "is", null)
    .or(`resume_claim_expires_at.is.null,resume_claim_expires_at.lt.${nowIso}`)
    .select("id, encode_resume_state")
    .maybeSingle();

  if (claimErr) {
    throw new Error(`EnCode resume-claim update failed: ${claimErr.message}`);
  }
  if (!claimed) {
    return { kind: "leased", documentId: candidate.id as string };
  }

  return {
    kind: "claimed",
    documentId: claimed.id as string,
    state: claimed.encode_resume_state as ResumeState,
  };
}

/**
 * Fetch the Amendment History Table's current text and hash it -- EnCode's
 * closest analog to Municode's /Jobs/latest job id (see file header
 * VERSION SIGNAL section). Used only for the top-level skip decision; the
 * node is also walked and ingested normally like every other node.
 */
async function fetchVersionSignalHash(
  baseUrl: string,
  userAgent: string,
): Promise<string> {
  const text = await fetchSectionContent(
    baseUrl,
    AMENDMENT_HISTORY_SECID,
    userAgent,
  );
  return await contentHash(text);
}

export async function handleEncode(
  pendingIngestionId: string,
  deadlineMs?: number,
  forceFullReingest = false,
): Promise<EncodeResult> {
  // 0. Compliance gate -- see file header COMPLIANCE NOTE / COMPLIANCE GATE.
  // Checked before any fetch() or db call so an unset secret costs nothing
  // beyond one status update, no matter which entry point reached this
  // function (cron poll or an explicit pending_ingestion_id call).
  if (Deno.env.get("ENCODE_ZONING_ENABLED") !== "true") {
    const { error: skipErr } = await db
      .from("pending_ingestions")
      .update({
        status: "skipped",
        last_error:
          "encode_zoning disabled pending human/legal sign-off on the robots.txt " +
          "/regs/ exclusion (see encode.ts file header) -- set ENCODE_ZONING_ENABLED=true to enable",
        updated_at: new Date().toISOString(),
      })
      .eq("id", pendingIngestionId);
    if (skipErr) {
      throw new Error(
        `Failed to mark EnCode ingestion as skipped (compliance gate): ${skipErr.message}`,
      );
    }
    console.warn(
      "[encode] ENCODE_ZONING_ENABLED is not set to 'true' — skipping without any network request",
    );
    return { documentId: "", nodeIds: [], skipped: true, complete: true };
  }

  const baseUrl = envOrDefault("ENCODE_BASE_URL", DEFAULT_ENCODE_BASE_URL);
  const userAgent = envOrDefault(
    "ENCODE_USER_AGENT",
    DEFAULT_ENCODE_USER_AGENT,
  );

  // 0. Resume in-progress walk, if any.
  const resumable = await findResumableDocument();
  if (resumable.kind === "leased") {
    console.log(
      `[encode] resume lease held by another invocation for document ${resumable.documentId} — requeueing`,
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
      `[encode] resuming in-progress walk for document ${resumable.documentId}`,
    );
    const ctx: IngestContext = {
      baseUrl,
      userAgent,
      documentId: resumable.documentId,
      effectiveDate: resumable.state.effectiveDate,
    };
    return await drainQueue(resumable.state.queue, ctx, deadlineMs, true);
  }

  // 1. Version signal + dedup.
  const hash = await fetchVersionSignalHash(baseUrl, userAgent);
  await sleep(REQUEST_DELAY_MS);

  const { data: existing, error: lookupErr } = await db
    .from("documents")
    .select("id")
    .eq("content_hash", hash)
    .eq("status", "current")
    .maybeSingle();
  if (lookupErr) {
    throw new Error(`EnCode dedup lookup failed: ${lookupErr.message}`);
  }

  const canonicalUrl = `${baseUrl}/doc-viewer.aspx?secid=${ROOT_SECID}`;
  const effectiveDate = defaultEffectiveDate();
  let documentId: string;

  if (existing && !forceFullReingest) {
    const { error: skipErr } = await db
      .from("pending_ingestions")
      .update({ status: "skipped", updated_at: new Date().toISOString() })
      .eq("id", pendingIngestionId);
    if (skipErr) {
      throw new Error(
        `Failed to mark EnCode ingestion as skipped: ${skipErr.message}`,
      );
    }
    console.log(`[encode] duplicate content_hash — skipped`);
    return {
      documentId: existing.id as string,
      nodeIds: [],
      skipped: true,
      complete: true,
    };
  } else if (existing && forceFullReingest) {
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
      `[encode] force_full_reingest — reopened existing document ${documentId}`,
    );
  } else {
    // Orphan-recovery check (mirrors municode.ts) -- a document row may
    // already exist at this URL from a prior invocation whose walk fully
    // drained but crashed before finalization.
    const { data: orphan, error: orphanErr } = await db
      .from("documents")
      .select("id, status, encode_resume_state")
      .eq("url", canonicalUrl)
      .maybeSingle();
    if (orphanErr) {
      throw new Error(
        `EnCode orphan-document lookup failed: ${orphanErr.message}`,
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
          encode_resume_state: orphan.encode_resume_state,
        }
        : null,
      provisionCount,
    );

    if (action === "finalize-only" || action === "rewalk-from-root") {
      const nowIso = new Date().toISOString();
      const leaseExpiresAt = new Date(
        Date.now() + RESUME_LEASE_MINUTES * 60 * 1000,
      ).toISOString();

      const { data: claimedOrphan, error: claimOrphanErr } = await db
        .from("documents")
        .update({ resume_claim_expires_at: leaseExpiresAt })
        .eq("id", orphan!.id as string)
        .is("encode_resume_state", null)
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
        console.log(
          `[encode] orphan-recovery claim held by another invocation for document ${
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
      documentId = orphan!.id as string;
      console.log(
        `[encode] recovering orphaned document ${documentId} — walk already drained (${provisionCount} provisions), skipping to finalization`,
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
      documentId = orphan!.id as string;
      console.log(
        `[encode] recovering orphaned document ${documentId} — no provisions written yet, re-walking from root`,
      );
    } else {
      const now = new Date().toISOString();
      documentId = uuidv7();

      const { error: docErr } = await db.from("documents").insert({
        id: documentId,
        url: canonicalUrl,
        filename: null,
        doc_type: "encode_zoning",
        status: "unknown",
        ingested_at: now,
        last_checked_at: now,
        content_hash: hash,
        source_published_at: null,
        title: "Fairfax County Zoning Ordinance (EnCode)",
        fiscal_year: null,
        docling_version: null,
        raw_api_response: { amendment_history_secid: AMENDMENT_HISTORY_SECID },
      });
      if (docErr) {
        throw new Error(`EnCode document insert failed: ${docErr.message}`);
      }
      console.log(`[encode] document shell created: ${documentId}`);
    }
  }

  // 2. Walk the full tree from the root's direct children.
  const rootChildren = await fetchTocChildren(
    baseUrl,
    ROOT_SECID,
    ROOT_TOCID,
    userAgent,
  );
  const queue: QueueItem[] = [];
  pushChildren(queue, rootChildren, ROOT_SECID, 1);

  const ctx: IngestContext = { baseUrl, userAgent, documentId, effectiveDate };
  return await drainQueue(queue, ctx, deadlineMs, false);
}
