/**
 * Pure helper functions for the reconciliation Edge Function.
 * Extracted here so they can be unit-tested without the Deno.serve() side-effect.
 */

import type { OllamaMessage } from "../_shared/ollama-client.ts";

export type ReconciliationResult =
  | "matched"
  | "partial_match"
  | "mismatch"
  | "not_found";

export interface OllamaReconciliationResult {
  result: ReconciliationResult;
  notes: string;
}

const VALID_RESULTS: ReconciliationResult[] = [
  "matched",
  "partial_match",
  "mismatch",
  "not_found",
];

export function parseLlmResult(content: string): OllamaReconciliationResult {
  const jsonMatch = content.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    console.warn("[reconciliation] LLM response has no JSON:", content.slice(0, 200));
    return { result: "mismatch", notes: "LLM response could not be parsed as JSON" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const result: ReconciliationResult = VALID_RESULTS.includes(
      parsed.result as ReconciliationResult,
    )
      ? (parsed.result as ReconciliationResult)
      : "mismatch";
    const notes = typeof parsed.notes === "string" ? parsed.notes : "";
    return { result, notes };
  } catch {
    console.warn("[reconciliation] LLM JSON parse failed:", content.slice(0, 200));
    return { result: "mismatch", notes: "LLM response JSON parse failed" };
  }
}

export function buildReconciliationMessages(
  pendingChange: { proposed_text: string | null; on_spot_edits: string | null },
  provision: { content: string },
): OllamaMessage[] {
  const pendingText = [
    pendingChange.proposed_text ?? "",
    pendingChange.on_spot_edits
      ? `\n\nOn-spot edits adopted by the Board:\n${pendingChange.on_spot_edits}`
      : "",
  ]
    .join("")
    .trim();

  return [
    {
      role: "system",
      content: `You are a legal code reconciliation assistant for Fairfax County, Virginia. Compare text adopted by the Board of Supervisors ("pending change") against the currently codified Municode provision ("codified provision") and determine whether the pending change has been accurately codified.

Return ONLY a JSON object with exactly two fields:
- "result": one of "matched", "partial_match", "mismatch", "not_found"
- "notes": a brief explanation (1-3 sentences)

Definitions:
- "matched": pending change text equals the codified provision (minor formatting differences acceptable)
- "partial_match": texts partially match but there are discrepancies worth human review
- "mismatch": significant divergence between pending change and codified provision
- "not_found": no comparable content found in the codified provision

Respond ONLY with valid JSON. No preamble, no text outside the JSON object.`,
    },
    {
      role: "user",
      content: `**Pending Code Change (adopted by Board of Supervisors):**
${pendingText || "(no proposed text provided)"}

**Currently Codified Provision (from Municode):**
${provision.content}`,
    },
  ];
}
