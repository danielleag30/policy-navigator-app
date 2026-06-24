/**
 * Municode API ingestion handler (task 2-5).
 *
 * Fetches the latest Fairfax County code export from Municode, creates a
 * Document shell row at status='unknown', and inserts ordinance_provisions
 * rows.  Returns structured data for the orchestrator (task 2-6) to use
 * in embedding generation, reconciliation, and document finalization.
 *
 * Does NOT set documents.status or generate embeddings — both are
 * task 2-6's responsibility.
 */

import db from "../_shared/db-client.ts";
import { contentHash } from "../_shared/hash.ts";

const PRODUCT_ID = "10051";
const CLIENT_ID = "5335";
const BULK_REQUEST_DELAY_MS = 500;

const REQUIRED_NODE_FIELDS = [
  "Id",
  "Content",
  "NodeDepth",
  "IsAmended",
  "AmendedBy",
  "Drafts",
] as const;

type MunicodeNode = Record<string, unknown> & {
  Id: string;
  Content: string;
  AdoptedDate?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function fetchJson(url: string, userAgent: string): Promise<unknown> {
  const resp = await fetch(url, { headers: { "User-Agent": userAgent } });
  if (!resp.ok) {
    throw new Error(`Municode API request failed: HTTP ${resp.status} at ${url}`);
  }
  return resp.json();
}

async function fetchText(url: string, userAgent: string): Promise<string> {
  const resp = await fetch(url, { headers: { "User-Agent": userAgent } });
  if (!resp.ok) {
    throw new Error(`Municode API request failed: HTTP ${resp.status} at ${url}`);
  }
  return resp.text();
}

function validateJobId(payload: unknown): string {
  if (
    typeof payload !== "object" || payload === null ||
    !("Id" in payload) ||
    (payload as Record<string, unknown>).Id == null
  ) {
    throw new Error("Municode Jobs response missing required field: Id");
  }
  return String((payload as Record<string, unknown>).Id);
}

function validateNodes(payload: unknown): MunicodeNode[] {
  if (!Array.isArray(payload)) {
    throw new Error("Municode CodesContent response must be a JSON array");
  }
  for (const [idx, node] of payload.entries()) {
    if (typeof node !== "object" || node === null) {
      throw new Error(`Municode node at index ${idx} must be an object`);
    }
    for (const field of REQUIRED_NODE_FIELDS) {
      if (!Object.hasOwn(node, field)) {
        throw new Error(
          `Municode node at index ${idx} missing required field: ${field}`,
        );
      }
    }
  }
  return payload as MunicodeNode[];
}

function datePlusOneDay(dateValue?: string): string {
  let base: Date;
  if (dateValue) {
    const m = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
    base = m
      ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
      : new Date(dateValue);
    if (Number.isNaN(base.getTime())) {
      throw new Error(`Invalid Municode AdoptedDate: ${dateValue}`);
    }
  } else {
    base = new Date();
  }
  base.setUTCDate(base.getUTCDate() + 1);
  return base.toISOString().slice(0, 10);
}

export interface MunicodeResult {
  documentId: string;
  nodeIds: string[];
  skipped: boolean;
}

/**
 * Fetch Municode export, create Document shell, insert ordinance_provisions.
 * Updates pending_ingestion to 'skipped' when content_hash already exists.
 * All other status transitions (done/failed) are handled by the orchestrator.
 */
export async function handleMunicode(
  pendingIngestionId: string,
): Promise<MunicodeResult> {
  const baseUrl = requireEnv("MUNICODE_BASE_URL");
  const userAgent = requireEnv("MUNICODE_USER_AGENT");

  const jobsUrl = `${baseUrl}/Jobs/latest/${PRODUCT_ID}`;
  const jobPayload = await fetchJson(jobsUrl, userAgent);
  const jobId = validateJobId(jobPayload);

  await sleep(BULK_REQUEST_DELAY_MS);

  const codesUrl =
    `${baseUrl}/CodesContent?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${jobId}`;
  const codesBody = await fetchText(codesUrl, userAgent);
  const codesPayload: unknown = JSON.parse(codesBody);
  const nodes = validateNodes(codesPayload);
  const hash = await contentHash(codesBody);

  // Dedup: if the same content_hash already has a current document, skip
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
    return { documentId: existing.id as string, nodeIds: [], skipped: true };
  }

  // Create Document shell at status='unknown'
  const now = new Date().toISOString();
  const documentId = crypto.randomUUID();

  const { error: docErr } = await db.from("documents").insert({
    id: documentId,
    url: codesUrl,
    filename: null,
    doc_type: "municode_api",
    status: "unknown",
    ingested_at: now,
    last_checked_at: now,
    content_hash: hash,
    source_published_at: null,
    title: null,
    fiscal_year: null,
    docling_version: null,
    raw_api_response: codesPayload,
  });

  if (docErr) {
    throw new Error(`Municode document insert failed: ${docErr.message}`);
  }

  // Insert ordinance_provisions
  const nodeIds: string[] = [];
  for (const node of nodes) {
    const nodeId = String(node.Id);
    const { error: provErr } = await db.from("ordinance_provisions").insert({
      id: crypto.randomUUID(),
      document_id: documentId,
      municode_node_id: nodeId,
      effective_date: typeof node.AdoptedDate === "string"
        ? datePlusOneDay(node.AdoptedDate)
        : datePlusOneDay(),
      is_current: false,
      section_title: null,
      content: String(node.Content),
    });

    if (provErr?.code === "23505") {
      console.warn(`[municode] duplicate provision skipped: ${nodeId}`);
      continue;
    }

    if (provErr) {
      throw new Error(`Municode provision insert failed: ${provErr.message}`);
    }

    nodeIds.push(nodeId);
  }

  return { documentId, nodeIds, skipped: false };
}
