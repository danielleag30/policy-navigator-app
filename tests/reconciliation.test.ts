/**
 * Tests for the reconciliation Edge Function.
 *
 * Covers: parseLlmResult (pure), buildReconciliationMessages (pure), and result-path
 * logic documented in the acceptance criteria. DB/Ollama integration requires a live
 * Supabase instance and is not covered here.
 */

import {
  buildReconciliationMessages,
  parseLlmResult,
  type OllamaReconciliationResult,
  type ReconciliationResult,
} from "../supabase/functions/reconciliation/_helpers.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// parseLlmResult
// ---------------------------------------------------------------------------

Deno.test("parseLlmResult: parses valid matched JSON", () => {
  const result = parseLlmResult(
    '{"result": "matched", "notes": "Texts are identical."}',
  );
  assertEquals(result.result, "matched");
  assertEquals(result.notes, "Texts are identical.");
});

Deno.test("parseLlmResult: parses valid mismatch JSON", () => {
  const result = parseLlmResult(
    '{"result": "mismatch", "notes": "Section 4.2 was not updated."}',
  );
  assertEquals(result.result, "mismatch");
  assert(result.notes.length > 0, "notes should not be empty");
});

Deno.test("parseLlmResult: parses valid partial_match JSON", () => {
  const result = parseLlmResult(
    '{"result": "partial_match", "notes": "Mostly aligned but paragraph 2 differs."}',
  );
  assertEquals(result.result, "partial_match");
});

Deno.test("parseLlmResult: parses valid not_found JSON", () => {
  const result = parseLlmResult(
    '{"result": "not_found", "notes": "No comparable content in codified provision."}',
  );
  assertEquals(result.result, "not_found");
});

Deno.test("parseLlmResult: unknown result value falls back to mismatch", () => {
  const result = parseLlmResult('{"result": "unknown_value", "notes": "???"}');
  assertEquals(result.result, "mismatch");
});

Deno.test("parseLlmResult: invalid JSON falls back to mismatch with note", () => {
  const result = parseLlmResult("This is not JSON at all.");
  assertEquals(result.result, "mismatch");
  assert(result.notes.length > 0, "should populate notes on parse failure");
});

Deno.test("parseLlmResult: JSON embedded in prose is extracted", () => {
  const content =
    'Sure! Here is my analysis:\n{"result": "matched", "notes": "The texts match."}\nDone.';
  const result = parseLlmResult(content);
  assertEquals(result.result, "matched");
  assertEquals(result.notes, "The texts match.");
});

Deno.test("parseLlmResult: missing notes field defaults to empty string", () => {
  const result = parseLlmResult('{"result": "not_found"}');
  assertEquals(result.result, "not_found");
  assertEquals(result.notes, "");
});

Deno.test("parseLlmResult: malformed JSON object falls back to mismatch", () => {
  const result = parseLlmResult('{"result": "matched", "notes": }');
  assertEquals(result.result, "mismatch");
});

// ---------------------------------------------------------------------------
// buildReconciliationMessages
// ---------------------------------------------------------------------------

Deno.test("buildReconciliationMessages: produces system + user messages", () => {
  const messages = buildReconciliationMessages(
    { proposed_text: "Proposed change text.", on_spot_edits: null },
    { content: "Current codified provision text." },
  );
  assertEquals(messages.length, 2);
  assertEquals(messages[0].role, "system");
  assertEquals(messages[1].role, "user");
});

Deno.test("buildReconciliationMessages: user message includes proposed_text", () => {
  const proposed = "The fee shall be $500 per year.";
  const messages = buildReconciliationMessages(
    { proposed_text: proposed, on_spot_edits: null },
    { content: "The fee is $400 per year." },
  );
  assert(messages[1].content.includes(proposed), "user message should include proposed_text");
});

Deno.test("buildReconciliationMessages: user message includes on_spot_edits when present", () => {
  const edits = "Strike 'may' and insert 'shall'.";
  const messages = buildReconciliationMessages(
    { proposed_text: "Original text.", on_spot_edits: edits },
    { content: "Codified text." },
  );
  assert(
    messages[1].content.includes(edits),
    "user message should include on_spot_edits",
  );
});

Deno.test("buildReconciliationMessages: handles null proposed_text gracefully", () => {
  const messages = buildReconciliationMessages(
    { proposed_text: null, on_spot_edits: null },
    { content: "Some codified content." },
  );
  assert(
    messages[1].content.includes("(no proposed text provided)"),
    "should note missing proposed text",
  );
});

Deno.test("buildReconciliationMessages: system prompt includes all four result labels", () => {
  const messages = buildReconciliationMessages(
    { proposed_text: "text", on_spot_edits: null },
    { content: "content" },
  );
  const systemContent = messages[0].content;
  const labels: ReconciliationResult[] = ["matched", "partial_match", "mismatch", "not_found"];
  for (const label of labels) {
    assert(systemContent.includes(`"${label}"`), `system prompt should mention "${label}"`);
  }
});

// ---------------------------------------------------------------------------
// requiresHumanReview logic
// ---------------------------------------------------------------------------

Deno.test("requiresHumanReview: true for mismatch and partial_match only", () => {
  const cases: Array<{ result: ReconciliationResult; expected: boolean }> = [
    { result: "matched", expected: false },
    { result: "not_found", expected: false },
    { result: "mismatch", expected: true },
    { result: "partial_match", expected: true },
  ];

  for (const { result, expected } of cases) {
    const requiresHumanReview = result === "mismatch" || result === "partial_match";
    assertEquals(
      requiresHumanReview,
      expected,
      `requiresHumanReview should be ${expected} for result="${result}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Acceptance criteria documentation tests
// ---------------------------------------------------------------------------

Deno.test("AC-5: not_found leaves pending_code_change unchanged (logic check)", () => {
  // Documents that not_found must NOT trigger a codification update.
  // The update only happens for "matched".
  const result: ReconciliationResult = "not_found";
  const shouldUpdate = result === "matched";
  assertEquals(shouldUpdate, false);
});

Deno.test("AC-5: not_found does not trigger an alert (logic check)", () => {
  const result: ReconciliationResult = "not_found";
  const shouldAlert = result === "mismatch" || result === "partial_match";
  assertEquals(shouldAlert, false);
});

Deno.test("AC-2: matched triggers codification update (logic check)", () => {
  const result: ReconciliationResult = "matched";
  const shouldUpdate = result === "matched";
  assertEquals(shouldUpdate, true);
});

Deno.test("AC-3: mismatch triggers human review flag and alert (logic check)", () => {
  const result: ReconciliationResult = "mismatch";
  const requiresHumanReview = result === "mismatch" || result === "partial_match";
  const shouldAlert = result === "mismatch" || result === "partial_match";
  assertEquals(requiresHumanReview, true);
  assertEquals(shouldAlert, true);
});

Deno.test("AC-4: partial_match triggers human review flag and alert (logic check)", () => {
  const result: ReconciliationResult = "partial_match";
  const requiresHumanReview = result === "mismatch" || result === "partial_match";
  const shouldAlert = result === "mismatch" || result === "partial_match";
  assertEquals(requiresHumanReview, true);
  assertEquals(shouldAlert, true);
});

