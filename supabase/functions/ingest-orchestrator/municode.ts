import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import db from "../_shared/db-client.ts";
import { contentHash } from "../_shared/hash.ts";
import { ollamaChat } from "../_shared/ollama-client.ts";
import { success } from "../_shared/response.ts";

const BASE_URL = () => Deno.env.get("MUNICODE_BASE_URL") ?? "";
const PRODUCT_ID = "10051";
const CLIENT_ID = "5335";
const userAgentHeader = () => ({
  "User-Agent": Deno.env.get("MUNICODE_USER_AGENT") ?? "policy-navigator/1.0",
});

interface MunicodeNode {
  Id: string;
  Content: string;
  NodeDepth: number;
  IsAmended?: boolean;
  AmendedBy?: string | null;
  Drafts?: unknown[] | null;
  [key: string]: unknown;
}

interface JobsResponse {
  Id: string;
  suppNumber?: string;
  [key: string]: unknown;
}

async function delay500(): Promise<void> {
  await new Promise((r) => setTimeout(r, 500));
}

async function computeEffectiveDate(
  node: MunicodeNode,
  jobData: JobsResponse
): Promise<string> {
  // If node has a freeform note field, use LLM to extract a date
  const noteField =
    (node as Record<string, unknown>).Note ??
    (node as Record<string, unknown>).EffectiveDateNote;
  if (noteField && typeof noteField === "string" && noteField.trim()) {
    const reply = await ollamaChat(
      [
        {
          role: "system",
          content:
            'Extract the effective date from this legal note. Return ONLY an ISO date string (YYYY-MM-DD) or "unknown" if no date is present.',
        },
        { role: "user", content: noteField },
      ],
      0.1
    );
    const match = reply.match(/\d{4}-\d{2}-\d{2}/);
    if (match) return match[0];
  }

  // Default: adopted_date + 1 day from the Jobs response
  const adoptedRaw =
    (node as Record<string, unknown>).AdoptedDate ??
    (jobData as Record<string, unknown>).AdoptedDate ??
    null;
  if (adoptedRaw && typeof adoptedRaw === "string") {
    const d = new Date(adoptedRaw);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().slice(0, 10);
}

export async function handleMunicode(
  pendingIngestionId: string
): Promise<Response> {
  const headers = userAgentHeader();

  // Step 1: Fetch Jobs metadata
  const jobsUrl = `${BASE_URL()}/Jobs/latest/${PRODUCT_ID}`;
  const jobsResp = await fetch(jobsUrl, { headers });
  if (!jobsResp.ok) {
    throw new Error(`Municode Jobs fetch failed: HTTP ${jobsResp.status}`);
  }
  const jobData: JobsResponse = await jobsResp.json();
  if (!jobData.Id) {
    throw new Error(
      "Municode Jobs response missing required field: Id"
    );
  }
  const jobId = jobData.Id;

  // 500ms delay before next request (AC-8)
  await delay500();

  // Step 2: Fetch CodesContent
  const codesUrl = `${BASE_URL()}/CodesContent?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${jobId}`;
  const codesResp = await fetch(codesUrl, { headers });
  if (!codesResp.ok) {
    throw new Error(
      `Municode CodesContent fetch failed: HTTP ${codesResp.status}`
    );
  }
  const codesBody = await codesResp.text();
  let codesContent: MunicodeNode[];
  try {
    codesContent = JSON.parse(codesBody);
  } catch {
    throw new Error("Municode CodesContent response is not valid JSON");
  }

  if (!Array.isArray(codesContent)) {
    throw new Error(
      "Municode CodesContent response expected an array of nodes"
    );
  }

  // Validate all nodes before doing anything else (AC-5: fail before shell row)
  for (let i = 0; i < codesContent.length; i++) {
    const node = codesContent[i];
    if (
      typeof node.Id !== "string" ||
      typeof node.Content !== "string" ||
      typeof node.NodeDepth !== "number" ||
      node.IsAmended === undefined
    ) {
      throw new Error(
        `Municode CodesContent node[${i}] missing required field(s): Id, Content, NodeDepth, IsAmended`
      );
    }
  }

  // 500ms delay before next request (AC-8)
  await delay500();

  // Step 3: Fetch ToC (fetched for completeness; stored in raw_api_response alongside codes)
  const tocUrl = `${BASE_URL()}/codesToc?clientId=${CLIENT_ID}&productId=${PRODUCT_ID}&jobId=${jobId}`;
  const tocResp = await fetch(tocUrl, { headers });
  if (!tocResp.ok) {
    throw new Error(`Municode codesToc fetch failed: HTTP ${tocResp.status}`);
  }
  // ToC not used in downstream logic but is fetched per spec

  // Step 1 of data flow: compute content_hash from Jobs response body BEFORE
  // writing any document or ordinance_provisions row (AC-1)
  const hash = await contentHash(JSON.stringify(jobData));

  // Deduplication check (AC-2)
  const { data: existing } = await db
    .from("documents")
    .select("id")
    .eq("content_hash", hash)
    .eq("status", "current")
    .maybeSingle();

  if (existing) {
    await db
      .from("pending_ingestions")
      .update({ status: "skipped" })
      .eq("id", pendingIngestionId);
    return success({ status: "skipped" });
  }

  // Create Document shell row BEFORE any OrdinanceProvision rows (AC-3)
  const { data: newDoc, error: insertErr } = await db
    .from("documents")
    .insert({
      id: crypto.randomUUID(),
      url: jobsUrl,
      content_hash: hash,
      doc_type: "municode_api",
      status: "unknown",
      ingested_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
      raw_api_response: JSON.parse(codesBody), // jsonb column — must be object, not string
    })
    .select("id")
    .single();

  if (insertErr || !newDoc) {
    throw new Error("Failed to create document shell row for municode_api");
  }

  const documentId = newDoc.id as string;

  // Parse nodes into ordinance_provisions rows (AC-4)
  for (const node of codesContent) {
    const effectiveDate = await computeEffectiveDate(node, jobData);

    const { error: provisionErr } = await db
      .from("ordinance_provisions")
      .insert({
        id: crypto.randomUUID(),
        document_id: documentId,
        municode_node_id: node.Id,
        effective_date: effectiveDate,
        is_current: false,
        section_title: null,
        content: node.Content,
      });

    if (provisionErr) {
      if (provisionErr.code === "23505") {
        // ON CONFLICT on UNIQUE (municode_node_id, effective_date): skip and warn (AC-9)
        console.warn(
          `Skipped duplicate ordinance_provision: node=${node.Id} effective_date=${effectiveDate}`
        );
      } else {
        throw new Error(
          `Failed to insert ordinance_provision for node ${node.Id}: ${provisionErr.message}`
        );
      }
    }
  }

  await db
    .from("pending_ingestions")
    .update({ status: "completed" })
    .eq("id", pendingIngestionId);

  return success({ status: "completed", document_id: documentId });
}
