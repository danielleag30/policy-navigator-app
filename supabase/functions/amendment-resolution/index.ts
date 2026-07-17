/**
 * amendment-resolution — code amendment resolution Edge Function.
 *
 * Closes the one missing consumer step between LLM extraction and reconciliation
 * (spec Section 2: the Board can adopt amendments before Municode codifies them):
 *
 *   extractor.ts sets policy_decisions.is_amendment = true at ingestion time
 *     -> (this function) resolves which currently-codified ordinance_provisions
 *        node the decision amends, and writes amendment_events + pending_code_changes
 *     -> reconciliation (unchanged) compares those pending_code_changes rows
 *        against fresh Municode/EnCode text and marks them "codified"
 *
 * Never fabricates a municode_node_id or a vote_tally_id: a decision is left
 * unresolved (and logged in amendment_resolution_logs) unless a candidate
 * ordinance provision can be confidently identified via citation/keyword match
 * plus a high-confidence LLM verification pass, AND the vote_tallies row that
 * actually corresponds to that decision can be independently verified on the
 * same document (policy_decisions.vote_tally_id itself is never trusted --
 * see pickVerifiedVoteTally in _helpers.ts for why).
 *
 * Triggered by pg_cron every 6 hours, or manually via HTTP POST -- same trust
 * boundary as reconciliation and change-detection (no extra admin gate; this is
 * routine recurring processing, not a one-off override).
 */

// deno-lint-ignore no-unversioned-import
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { generate as uuidv7 } from "@std/uuid/v7";
import db from "../_shared/db-client.ts";
import { ollamaChat } from "../_shared/ollama-client.ts";
import { error, success } from "../_shared/response.ts";
import { elapsed, logError, logInfo, logWarn } from "../_shared/logger.ts";
import {
  buildAmendmentEventRow,
  buildPendingCodeChangeRow,
  buildResolutionMessages,
  extractCitationTokens,
  extractKeywords,
  type OrdinanceCandidate,
  parseResolutionLlmResult,
  pickVerifiedVoteTally,
  type PolicyDecisionForResolution,
  rankAndCapCandidates,
  shouldAcceptResolution,
  type VoteTallyCandidate,
} from "./_helpers.ts";

const FN_NAME = "amendment-resolution";
const RESOLUTION_TEMPERATURE = 0.0; // deterministic judging, same rationale as reconciliation
const MAX_DECISIONS_PER_RUN = 40;
const SOFT_DEADLINE_MS = 100_000; // edge functions hard-kill around ~150s
const CANDIDATE_CAP = 8;
const UNIQUE_VIOLATION_CODE = "23505";

interface AmendmentResolutionLogRow {
  policy_decision_id: string;
}

async function loadUnresolvedDecisions(): Promise<
  PolicyDecisionForResolution[]
> {
  const { data: decisions, error: decErr } = await db
    .from("policy_decisions")
    .select(
      "id, document_id, meeting_date, decision_type, subject, effective_date, raw_extracted_text",
    )
    .eq("is_amendment", true)
    .order("meeting_date", { ascending: true })
    .limit(200);

  if (decErr) {
    throw new Error(`policy_decisions lookup failed: ${decErr.message}`);
  }

  const { data: logged, error: logErr } = await db
    .from("amendment_resolution_logs")
    .select("policy_decision_id");

  if (logErr) {
    throw new Error(
      `amendment_resolution_logs lookup failed: ${logErr.message}`,
    );
  }

  const loggedIds = new Set(
    ((logged ?? []) as AmendmentResolutionLogRow[]).map((r) =>
      r.policy_decision_id
    ),
  );

  return ((decisions ?? []) as PolicyDecisionForResolution[])
    .filter((d) => !loggedIds.has(d.id))
    .slice(0, MAX_DECISIONS_PER_RUN);
}

async function fetchCandidates(
  keywords: string[],
  citationTokens: string[],
): Promise<OrdinanceCandidate[]> {
  const candidates: OrdinanceCandidate[] = [];

  for (const token of citationTokens) {
    const { data, error: rpcErr } = await db
      .from("ordinance_provisions")
      .select("id, municode_node_id, section_title, content")
      .eq("is_current", true)
      .ilike("municode_node_id", `%${token}%`)
      .limit(10);
    if (rpcErr) {
      logWarn(FN_NAME, "citation candidate lookup failed", {
        token,
        message: rpcErr.message,
      });
      continue;
    }
    candidates.push(...((data ?? []) as OrdinanceCandidate[]));
  }

  for (const keyword of keywords.slice(0, 4)) {
    const { data: bm25Data, error: bm25Err } = await db.rpc(
      "bm25_ordinance_provisions",
      {
        p_query_text: keyword,
        p_limit: 5,
      },
    );
    if (bm25Err) {
      logWarn(FN_NAME, "bm25 candidate lookup failed", {
        keyword,
        message: bm25Err.message,
      });
    } else {
      candidates.push(
        ...((bm25Data ?? []) as (OrdinanceCandidate & {
          is_current: boolean;
        })[])
          .filter((c) => c.is_current)
          .map((c) => ({
            id: c.id,
            municode_node_id: c.municode_node_id,
            section_title: c.section_title,
            content: c.content,
          })),
      );
    }

    const { data: titleData, error: titleErr } = await db
      .from("ordinance_provisions")
      .select("id, municode_node_id, section_title, content")
      .eq("is_current", true)
      .ilike("section_title", `%${keyword}%`)
      .limit(5);
    if (titleErr) {
      logWarn(FN_NAME, "title candidate lookup failed", {
        keyword,
        message: titleErr.message,
      });
    } else {
      candidates.push(...((titleData ?? []) as OrdinanceCandidate[]));
    }
  }

  return candidates;
}

async function fetchVoteTallyCandidates(
  documentId: string,
): Promise<VoteTallyCandidate[]> {
  const { data, error: err } = await db
    .from("vote_tallies")
    .select("id, motion_text")
    .eq("document_id", documentId)
    .limit(50);

  if (err) {
    logWarn(FN_NAME, "vote_tallies lookup failed", {
      document_id: documentId,
      message: err.message,
    });
    return [];
  }

  return (data ?? []) as VoteTallyCandidate[];
}

async function logUnresolved(
  decision: PolicyDecisionForResolution,
  reason: "missing_vote_tally" | "no_candidates" | "low_confidence",
  confidence: "high" | "medium" | "low" | null,
  llmNotes: string | null,
  resolvedNodeId: string | null = null,
): Promise<void> {
  const { error: insertErr } = await db.from("amendment_resolution_logs")
    .insert({
      id: uuidv7(),
      policy_decision_id: decision.id,
      status: "unresolved",
      reason,
      municode_node_id: resolvedNodeId,
      confidence,
      llm_notes: llmNotes,
      amendment_event_id: null,
      pending_code_change_id: null,
    });

  if (insertErr && insertErr.code !== UNIQUE_VIOLATION_CODE) {
    throw new Error(
      `amendment_resolution_logs insert failed: ${insertErr.message}`,
    );
  }
}

async function resolveDecision(
  decision: PolicyDecisionForResolution,
): Promise<"resolved" | "unresolved" | "transient_skip"> {
  const searchText = `${decision.subject} ${
    decision.raw_extracted_text.slice(0, 2000)
  }`;
  const citationTokens = extractCitationTokens(searchText);
  const keywords = extractKeywords(decision.subject);

  const rawCandidates = await fetchCandidates(keywords, citationTokens);
  const candidates = rankAndCapCandidates(
    rawCandidates,
    citationTokens,
    CANDIDATE_CAP,
  );

  if (candidates.length === 0) {
    await logUnresolved(decision, "no_candidates", null, null);
    return "unresolved";
  }

  const messages = buildResolutionMessages(decision, candidates);
  const llmResult = await ollamaChat(messages, RESOLUTION_TEMPERATURE);

  if (llmResult.exhausted) {
    logWarn(FN_NAME, "Ollama exhausted for decision — will retry next run", {
      policy_decision_id: decision.id,
    });
    return "transient_skip";
  }

  const validNodeIds = new Set(candidates.map((c) => c.municode_node_id));
  const parsed = parseResolutionLlmResult(llmResult.content, validNodeIds);

  if (!shouldAcceptResolution(parsed)) {
    await logUnresolved(
      decision,
      "low_confidence",
      parsed.confidence,
      parsed.notes,
    );
    return "unresolved";
  }

  // The node is resolved -- now find the vote_tallies row that actually
  // corresponds to THIS decision. policy_decisions.vote_tally_id (extraction-
  // time chunk adjacency) is never trusted directly: a board meeting document
  // routinely bundles several unrelated votes, and that link can point at the
  // wrong one. Search every vote on the same document with the same
  // citation/keyword signal used for node resolution instead.
  const voteCandidates = await fetchVoteTallyCandidates(decision.document_id);
  const voteMatch = pickVerifiedVoteTally(
    voteCandidates,
    keywords,
    citationTokens,
  );

  if (!voteMatch.vote_tally_id) {
    await logUnresolved(
      decision,
      "missing_vote_tally",
      parsed.confidence,
      `Node resolved to ${parsed.municode_node_id} but no verified vote tally found among ${voteCandidates.length} vote(s) on document ${decision.document_id}. ${parsed.notes}`
        .trim(),
      parsed.municode_node_id,
    );
    return "unresolved";
  }

  const amendmentEventId = uuidv7();
  const amendmentEventRow = buildAmendmentEventRow(
    decision,
    parsed.municode_node_id!,
    voteMatch.vote_tally_id,
    amendmentEventId,
  );

  const { error: eventErr } = await db.from("amendment_events").insert(
    amendmentEventRow,
  );
  if (eventErr) {
    throw new Error(`amendment_events insert failed: ${eventErr.message}`);
  }

  const pendingChangeId = uuidv7();
  const pendingChangeRow = buildPendingCodeChangeRow(
    decision,
    parsed.municode_node_id!,
    amendmentEventId,
    pendingChangeId,
  );

  const { error: pccErr } = await db.from("pending_code_changes").insert(
    pendingChangeRow,
  );
  if (pccErr) {
    throw new Error(`pending_code_changes insert failed: ${pccErr.message}`);
  }

  const { error: logErr } = await db.from("amendment_resolution_logs").insert({
    id: uuidv7(),
    policy_decision_id: decision.id,
    status: "resolved",
    reason: null,
    municode_node_id: parsed.municode_node_id,
    confidence: parsed.confidence,
    llm_notes:
      `${parsed.notes} [vote_tally verified via ${voteMatch.matched_via}]`
        .trim(),
    amendment_event_id: amendmentEventId,
    pending_code_change_id: pendingChangeId,
  });

  if (logErr && logErr.code !== UNIQUE_VIOLATION_CODE) {
    throw new Error(
      `amendment_resolution_logs insert failed: ${logErr.message}`,
    );
  }

  return "resolved";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return error("NOT_FOUND", "Method not allowed", 405);
  }

  const runStart = Date.now();

  try {
    const decisions = await loadUnresolvedDecisions();

    let resolved = 0;
    let unresolved = 0;
    let transientSkips = 0;
    const results: Array<
      { policy_decision_id: string; outcome: string; error?: string }
    > = [];

    for (const decision of decisions) {
      if (elapsed(runStart) >= SOFT_DEADLINE_MS) {
        logWarn(
          FN_NAME,
          "soft deadline reached — stopping early, remainder picked up next run",
          {
            processed: results.length,
            remaining: decisions.length - results.length,
          },
        );
        break;
      }

      try {
        const outcome = await resolveDecision(decision);
        if (outcome === "resolved") resolved++;
        else if (outcome === "unresolved") unresolved++;
        else transientSkips++;
        results.push({ policy_decision_id: decision.id, outcome });
      } catch (e) {
        const message = (e as Error).message;
        logError(FN_NAME, "decision resolution failed", {
          policy_decision_id: decision.id,
          message,
        });
        results.push({
          policy_decision_id: decision.id,
          outcome: "error",
          error: message,
        });
      }
    }

    logInfo(FN_NAME, "amendment resolution run complete", {
      resolved,
      unresolved,
      transient_skips: transientSkips,
      elapsed_ms: elapsed(runStart),
    });

    return success({
      resolved,
      unresolved,
      transient_skips: transientSkips,
      results,
    });
  } catch (e) {
    logError(FN_NAME, "fatal error", { message: (e as Error).message });
    return error("INGESTION_FAILED", "Amendment resolution failed", 500);
  }
});
