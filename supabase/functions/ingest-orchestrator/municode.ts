import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import db from "../_shared/db-client.ts";
import { contentHash } from "../_shared/hash.ts";
import { success } from "../_shared/response.ts";

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
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function fetchJson(url: string, userAgent: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
    },
  });

  if (!resp.ok) {
    throw new Error(`Municode API request failed: HTTP ${resp.status}`);
  }

  return await resp.json();
}

async function fetchText(url: string, userAgent: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
    },
  });

  if (!resp.ok) {
    throw new Error(`Municode API request failed: HTTP ${resp.status}`);
  }

  return await resp.text();
}

function validateJobId(payload: unknown): string {
  if (
    typeof payload !== "object" || payload === null || !("Id" in payload) ||
    (payload as Record<string, unknown>).Id === undefined ||
    (payload as Record<string, unknown>).Id === null
  ) {
    throw new Error("Municode Jobs response missing required field: Id");
  }

  return String((payload as Record<string, unknown>).Id);
}

function validateNodes(payload: unknown): MunicodeNode[] {
  if (!Array.isArray(payload)) {
    throw new Error("Municode CodesContent response must be a JSON array");
  }

  for (const [index, node] of payload.entries()) {
    if (typeof node !== "object" || node === null) {
      throw new Error(
        `Municode CodesContent node at index ${index} must be an object`,
      );
    }

    for (const field of REQUIRED_NODE_FIELDS) {
      if (!Object.hasOwn(node, field)) {
        throw new Error(
          `Municode CodesContent node at index ${index} missing required field: ${field}`,
        );
      }
    }
  }

  return payload as MunicodeNode[];
}

function datePlusOneDay(dateValue?: string): string {
  const base = dateValue ? parseDate(dateValue) : new Date();
  base.setUTCDate(base.getUTCDate() + 1);
  return base.toISOString().slice(0, 10);
}

function parseDate(dateValue: string): Date {
  const dateOnly = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid Municode AdoptedDate: ${dateValue}`);
  }
  return parsed;
}

export async function handleMunicode(
  pendingIngestionId: string,
): Promise<Response> {
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

  const { data: existing, error: existingLookupErr } = await db
    .from("documents")
    .select("id")
    .eq("content_hash", hash)
    .eq("status", "current")
    .maybeSingle();

  if (existingLookupErr) {
    throw new Error("Failed to check existing Municode document row");
  }

  if (existing) {
    const { error: skippedUpdateErr } = await db
      .from("pending_ingestions")
      .update({ status: "skipped" })
      .eq("id", pendingIngestionId);

    if (skippedUpdateErr) {
      throw new Error("Failed to skip Municode pending ingestion row");
    }

    return success({ status: "skipped" });
  }

  const now = new Date().toISOString();
  const documentId = crypto.randomUUID();
  const { error: documentInsertErr } = await db
    .from("documents")
    .insert({
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

  if (documentInsertErr) {
    throw new Error("Failed to create Municode document row");
  }

  let provisionsCount = 0;
  for (const node of nodes) {
    const { error: provisionInsertErr } = await db
      .from("ordinance_provisions")
      .insert({
        id: crypto.randomUUID(),
        document_id: documentId,
        municode_node_id: String(node.Id),
        effective_date: typeof node.AdoptedDate === "string"
          ? datePlusOneDay(node.AdoptedDate)
          : datePlusOneDay(),
        is_current: false,
        section_title: null,
        content: String(node.Content),
      });

    if (provisionInsertErr?.code === "23505") {
      console.warn(
        "Skipping duplicate Municode provision:",
        node.Id,
        provisionInsertErr.message,
      );
      continue;
    }

    if (provisionInsertErr) {
      throw new Error("Failed to insert Municode ordinance provision row");
    }

    provisionsCount += 1;
  }

  const { error: pendingUpdateErr } = await db
    .from("pending_ingestions")
    .update({ status: "completed" })
    .eq("id", pendingIngestionId);

  if (pendingUpdateErr) {
    throw new Error("Failed to complete Municode pending ingestion row");
  }

  return success({
    status: "completed",
    document_id: documentId,
    provisions_count: provisionsCount,
  });
}
