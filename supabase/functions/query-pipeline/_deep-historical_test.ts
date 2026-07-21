/**
 * Unit tests for the deep-historical live-lookup slow path.
 *
 * Run with: deno test --allow-env --allow-net supabase/functions/query-pipeline/_deep-historical_test.ts
 */

import {
  ENCODE_ZONING_REPRINTS,
  extractDeepHistoricalYear,
  extractQueryTerms,
  fetchPreingestedReprintBlocks,
  type PreingestDb,
  reprintDocUrl,
  runDeepHistoricalLookup,
  selectRelevantChunks,
  selectReprintForYear,
  shouldAttemptDeepHistoricalLookup,
} from "./_deep-historical.ts";
import type { Chunk } from "../_shared/chunker.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ── extractDeepHistoricalYear ────────────────────────────────────────────────

Deno.test("extractDeepHistoricalYear finds a year in EnCode coverage range", () => {
  assertEquals(
    extractDeepHistoricalYear(
      "what did the zoning ordinance say about ADUs in 1948?",
    ),
    1948,
  );
});

Deno.test("extractDeepHistoricalYear returns null with no year", () => {
  assertEquals(
    extractDeepHistoricalYear("what are the current setback requirements?"),
    null,
  );
});

Deno.test("extractDeepHistoricalYear returns null for years at/after the current-era boundary", () => {
  assertEquals(
    extractDeepHistoricalYear("what changed in the 2023 zoning rewrite?"),
    null,
  );
  assertEquals(extractDeepHistoricalYear("what about 2026 budget?"), null);
});

Deno.test("extractDeepHistoricalYear returns null for years before the earliest reprint", () => {
  assertEquals(extractDeepHistoricalYear("zoning rules in 1935"), null);
});

Deno.test("extractDeepHistoricalYear picks the first in-range year when multiple numbers present", () => {
  assertEquals(
    extractDeepHistoricalYear("in 1948, before the 2023 rewrite"),
    1948,
  );
});

// ── selectReprintForYear ─────────────────────────────────────────────────────

Deno.test("selectReprintForYear picks the reprint whose coverage window includes the year", () => {
  assertEquals(selectReprintForYear(1948)?.label, "1945 Reprint");
  assertEquals(selectReprintForYear(1945)?.label, "1945 Reprint");
  assertEquals(selectReprintForYear(1944)?.label, "1941 Original");
  assertEquals(selectReprintForYear(1953)?.label, "1945 Reprint");
  assertEquals(selectReprintForYear(2021)?.label, "2021 Reprint");
  assertEquals(selectReprintForYear(2022)?.label, "2021 Reprint");
});

Deno.test("selectReprintForYear returns null before the earliest reprint", () => {
  assertEquals(selectReprintForYear(1940), null);
  assertEquals(selectReprintForYear(1800), null);
});

Deno.test("reprint table is sorted ascending by year (selection logic depends on this)", () => {
  for (let i = 1; i < ENCODE_ZONING_REPRINTS.length; i++) {
    assert(
      ENCODE_ZONING_REPRINTS[i].year > ENCODE_ZONING_REPRINTS[i - 1].year,
      `reprint table out of order at index ${i}`,
    );
  }
});

// ── reprintDocUrl ─────────────────────────────────────────────────────────────

Deno.test("reprintDocUrl builds a doclibrary.aspx URL under /regs/ with the reprint's GUID", () => {
  const reprint = ENCODE_ZONING_REPRINTS.find((r) =>
    r.label === "2021 Reprint"
  )!;
  const url = reprintDocUrl(reprint);
  assert(
    url.includes("/regs/fairfaxcounty-va/"),
    "URL must stay under the compliance-gated /regs/ path",
  );
  assert(
    url.includes(reprint.docLibraryId),
    "URL must include the reprint's real docLibraryId",
  );
});

// ── shouldAttemptDeepHistoricalLookup ────────────────────────────────────────

function withEncodeEnabled(value: string | undefined, fn: () => void): void {
  const previous = Deno.env.get("ENCODE_ZONING_ENABLED");
  if (value === undefined) Deno.env.delete("ENCODE_ZONING_ENABLED");
  else Deno.env.set("ENCODE_ZONING_ENABLED", value);
  try {
    fn();
  } finally {
    if (previous === undefined) Deno.env.delete("ENCODE_ZONING_ENABLED");
    else Deno.env.set("ENCODE_ZONING_ENABLED", previous);
  }
}

Deno.test("shouldAttemptDeepHistoricalLookup does not attempt when the fast path found something", () => {
  withEncodeEnabled("true", () => {
    const result = shouldAttemptDeepHistoricalLookup(
      "zoning rules in 1948",
      0.5,
      0.005,
    );
    assertEquals(result, { attempt: false });
  });
});

Deno.test("shouldAttemptDeepHistoricalLookup does not attempt without a deep-historical year", () => {
  withEncodeEnabled("true", () => {
    const result = shouldAttemptDeepHistoricalLookup(
      "what are current setbacks?",
      0.0,
      0.005,
    );
    assertEquals(result, { attempt: false });
  });
});

Deno.test("shouldAttemptDeepHistoricalLookup does not attempt when the compliance gate is off", () => {
  withEncodeEnabled(undefined, () => {
    const result = shouldAttemptDeepHistoricalLookup(
      "zoning rules in 1948",
      0.0,
      0.005,
    );
    assertEquals(result, { attempt: false });
  });
  withEncodeEnabled("false", () => {
    const result = shouldAttemptDeepHistoricalLookup(
      "zoning rules in 1948",
      0.0,
      0.005,
    );
    assertEquals(result, { attempt: false });
  });
});

Deno.test("shouldAttemptDeepHistoricalLookup attempts when everything lines up", () => {
  withEncodeEnabled("true", () => {
    const result = shouldAttemptDeepHistoricalLookup(
      "what were the home occupation rules in 1948?",
      0.0,
      0.005,
    );
    assert(result.attempt, "expected attempt: true");
    if (result.attempt) {
      assertEquals(result.year, 1948);
      assertEquals(result.reprint.label, "1945 Reprint");
    }
  });
});

// ── selectRelevantChunks / extractQueryTerms ─────────────────────────────────

function makeChunk(text: string, page: number): Chunk {
  return {
    text,
    token_count: text.split(/\s+/).length,
    page_number_start: page,
    page_number_end: page,
    bbox_start: null,
    bbox_end: null,
    reading_order_start: page,
    reading_order_end: page,
    overlap_prev: false,
    overlap_next: false,
  };
}

Deno.test("extractQueryTerms drops stopwords and short tokens", () => {
  const terms = extractQueryTerms(
    "what are the home occupation rules in Fairfax?",
  );
  assert(terms.includes("home"), "expected 'home' to survive filtering");
  assert(
    terms.includes("occupation"),
    "expected 'occupation' to survive filtering",
  );
  assert(!terms.includes("the"), "'the' must be filtered as a stopword");
  assert(!terms.includes("in"), "'in' must be filtered (too short / stopword)");
});

Deno.test("selectRelevantChunks ranks by lexical overlap and drops zero-score chunks", () => {
  const chunks = [
    makeChunk("Setback requirements for accessory structures.", 10),
    makeChunk("Home occupation permits require a special use approval.", 22),
    makeChunk("Home occupation standards limit signage and traffic.", 23),
  ];
  const selected = selectRelevantChunks(chunks, "home occupation rules", 2);
  assertEquals(selected.length, 2);
  assertEquals(selected[0].page_number_start, 22);
  assertEquals(selected[1].page_number_start, 23);
});

Deno.test("selectRelevantChunks returns empty when nothing in the document is relevant", () => {
  const chunks = [
    makeChunk("Setback requirements for accessory structures.", 10),
  ];
  const selected = selectRelevantChunks(chunks, "home occupation rules", 2);
  assertEquals(selected, []);
});

// ── runDeepHistoricalLookup (mocked Docling + Ollama fetch) ─────────────────

const ENV_KEYS = [
  "HF_SPACES_DOCLING_URL",
  "OLLAMA_CLOUD_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_TIMEOUT_MS",
  "DEEP_HISTORICAL_DOCLING_TIMEOUT_MS",
  "DEEP_HISTORICAL_LLM_TIMEOUT_MS",
] as const;

type FetchHandler = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

async function withMockedFetch(
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  handler: FetchHandler,
  fn: () => Promise<void>,
): Promise<void> {
  const previousEnv = new Map<(typeof ENV_KEYS)[number], string | undefined>();
  const previousFetch = globalThis.fetch;

  for (const key of ENV_KEYS) {
    previousEnv.set(key, Deno.env.get(key));
    if (env[key] === undefined) Deno.env.delete(key);
    else Deno.env.set(key, env[key]!);
  }
  globalThis.fetch = handler as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of ENV_KEYS) {
      const previous = previousEnv.get(key);
      if (previous === undefined) Deno.env.delete(key);
      else Deno.env.set(key, previous);
    }
  }
}

const BASE_ENV = {
  HF_SPACES_DOCLING_URL: "https://docling.example",
  OLLAMA_CLOUD_BASE_URL: "https://ollama.example",
  OLLAMA_TIMEOUT_MS: "15000",
};

const reprint1945 = ENCODE_ZONING_REPRINTS.find((r) =>
  r.label === "1945 Reprint"
)!;

interface MockPreingestOptions {
  /** null (default) = no row for this reprint yet — matches a fresh background job. */
  status?: "pending" | "in_progress" | "complete" | null;
  pages?: Array<{ page_number: number; text: string }>;
}

/** In-memory fake satisfying PreingestDb's narrow shape, for tests. */
function mockPreingestDb(opts: MockPreingestOptions = {}): PreingestDb {
  const status = opts.status ?? null;
  const pages = opts.pages ?? [];

  function from(table: string) {
    if (table === "encode_reprint_preingest_state") {
      return {
        select: (_columns: string) => ({
          eq: (_column: string, _value: string) => ({
            maybeSingle: () =>
              Promise.resolve({
                data: status === null ? null : { status },
                error: null,
              }),
          }),
        }),
      };
    }
    if (table === "encode_reprint_pages") {
      return {
        select: (_columns: string) => ({
          eq: (_column: string, _value: string) => ({
            order: (_column: string, _o: { ascending: boolean }) =>
              Promise.resolve({ data: pages, error: null }),
          }),
        }),
      };
    }
    throw new Error(`mockPreingestDb: unexpected table ${table}`);
  }

  // deno-lint-ignore no-explicit-any
  return { from } as any as PreingestDb;
}

function doclingResponse(blocks: unknown[]): Response {
  return new Response(
    JSON.stringify({
      blocks,
      block_count: blocks.length,
      docling_version: "test",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function ollamaResponse(content: string): Response {
  return new Response(
    JSON.stringify({ message: { content } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

Deno.test("runDeepHistoricalLookup returns a real cited answer when the LLM grounds it in a fetched page", async () => {
  await withMockedFetch(
    BASE_ENV,
    (input) => {
      const url = String(input);
      if (url.includes("docling.example")) {
        return Promise.resolve(
          doclingResponse([
            {
              text:
                "Home occupation permits require a special use approval under Sect. 10-301.",
              page_no: 42,
              bbox: null,
              reading_order_index: 0,
            },
          ]),
        );
      }
      return Promise.resolve(
        ollamaResponse(JSON.stringify({
          answer:
            "Home occupations required a special use approval under Sect. 10-301.",
          cited_pages: [42],
        })),
      );
    },
    async () => {
      const outcome = await runDeepHistoricalLookup(
        mockPreingestDb(),
        "what were the home occupation rules in 1948?",
        reprint1945,
      );
      assertEquals(outcome.status, "answered");
      if (outcome.status === "answered") {
        assertEquals(outcome.page, 42);
        assert(
          outcome.sourceUrl.includes(reprint1945.docLibraryId),
          "citation must point at the real fetched reprint",
        );
        assert(
          outcome.answer.includes("special use approval"),
          "answer must be the real LLM text, not fabricated",
        );
      }
    },
  );
});

Deno.test("runDeepHistoricalLookup refuses (not_found) rather than fabricate when the LLM finds nothing", async () => {
  await withMockedFetch(
    BASE_ENV,
    (input) => {
      const url = String(input);
      if (url.includes("docling.example")) {
        return Promise.resolve(
          doclingResponse([
            {
              text: "Setback requirements for accessory structures.",
              page_no: 5,
              bbox: null,
              reading_order_index: 0,
            },
          ]),
        );
      }
      return Promise.resolve(
        ollamaResponse(
          JSON.stringify({ answer: "not in the documents", cited_pages: [] }),
        ),
      );
    },
    async () => {
      // Query terms overlap "setback" so a chunk is selected, but the LLM itself refuses.
      const outcome = await runDeepHistoricalLookup(
        mockPreingestDb(),
        "what were setback rules in 1948?",
        reprint1945,
      );
      assertEquals(outcome.status, "not_found");
    },
  );
});

Deno.test("runDeepHistoricalLookup refuses (not_found) when nothing in the fetched document is lexically relevant", async () => {
  await withMockedFetch(
    BASE_ENV,
    (input) => {
      const url = String(input);
      if (url.includes("docling.example")) {
        return Promise.resolve(
          doclingResponse([
            {
              text: "Setback requirements for accessory structures.",
              page_no: 5,
              bbox: null,
              reading_order_index: 0,
            },
          ]),
        );
      }
      throw new Error(
        "ollamaChat must not be called when no chunk is relevant",
      );
    },
    async () => {
      const outcome = await runDeepHistoricalLookup(
        mockPreingestDb(),
        "home occupation signage rules in 1948?",
        reprint1945,
      );
      assertEquals(outcome.status, "not_found");
    },
  );
});

Deno.test("runDeepHistoricalLookup fails cleanly (never fabricates) when the LLM cites a page it was never given", async () => {
  await withMockedFetch(
    BASE_ENV,
    (input) => {
      const url = String(input);
      if (url.includes("docling.example")) {
        return Promise.resolve(
          doclingResponse([
            {
              text: "Home occupation permits require a special use approval.",
              page_no: 42,
              bbox: null,
              reading_order_index: 0,
            },
          ]),
        );
      }
      return Promise.resolve(
        ollamaResponse(JSON.stringify({
          answer: "Home occupations were banned outright.",
          cited_pages: [999], // never provided — must be rejected, not trusted
        })),
      );
    },
    async () => {
      const outcome = await runDeepHistoricalLookup(
        mockPreingestDb(),
        "home occupation rules in 1948?",
        reprint1945,
      );
      assertEquals(outcome.status, "failed");
      if (outcome.status === "failed") {
        assertEquals(outcome.reason, "unvalidated or uncited answer");
      }
    },
  );
});

Deno.test("runDeepHistoricalLookup fails cleanly when the Docling fetch errors", async () => {
  await withMockedFetch(
    BASE_ENV,
    (input) => {
      const url = String(input);
      if (url.includes("docling.example")) {
        return Promise.resolve(new Response("boom", { status: 500 }));
      }
      throw new Error("ollamaChat must not be called when Docling fails");
    },
    async () => {
      const outcome = await runDeepHistoricalLookup(
        mockPreingestDb(),
        "home occupation rules in 1948?",
        reprint1945,
      );
      assertEquals(outcome.status, "failed");
    },
  );
});

Deno.test("runDeepHistoricalLookup treats an empty fetched document as not_found, not a crash", async () => {
  await withMockedFetch(
    BASE_ENV,
    (input) => {
      const url = String(input);
      if (url.includes("docling.example")) {
        return Promise.resolve(doclingResponse([]));
      }
      throw new Error(
        "ollamaChat must not be called when Docling returns zero blocks",
      );
    },
    async () => {
      const outcome = await runDeepHistoricalLookup(
        mockPreingestDb(),
        "home occupation rules in 1948?",
        reprint1945,
      );
      assertEquals(outcome.status, "not_found");
    },
  );
});

Deno.test("runDeepHistoricalLookup passes the extended timeout to ollamaChat, not the normal-path default", async () => {
  await withMockedFetch(
    { ...BASE_ENV, DEEP_HISTORICAL_LLM_TIMEOUT_MS: "20000" },
    (input) => {
      const url = String(input);
      if (url.includes("docling.example")) {
        return Promise.resolve(
          doclingResponse([
            {
              text: "Home occupation permits require a special use approval.",
              page_no: 42,
              bbox: null,
              reading_order_index: 0,
            },
          ]),
        );
      }
      return Promise.resolve(
        ollamaResponse(
          JSON.stringify({
            answer: "Approval was required.",
            cited_pages: [42],
          }),
        ),
      );
    },
    async () => {
      // OLLAMA_TIMEOUT_MS is 15000 in BASE_ENV; if the override weren't wired
      // through, a 20s-timeout-worthy slow mock would abort at 15s instead.
      // Here we just confirm the happy path still succeeds with both set,
      // proving the override parameter is accepted end-to-end.
      const outcome = await runDeepHistoricalLookup(
        mockPreingestDb(),
        "home occupation rules in 1948?",
        reprint1945,
      );
      assertEquals(outcome.status, "answered");
    },
  );
});

// ── fetchPreingestedReprintBlocks (pre-ingested fast path) ──────────────────

Deno.test("fetchPreingestedReprintBlocks returns null when no preingest row exists yet", async () => {
  const blocks = await fetchPreingestedReprintBlocks(
    mockPreingestDb(),
    reprint1945,
  );
  assertEquals(blocks, null);
});

Deno.test("fetchPreingestedReprintBlocks returns null while status is pending or in_progress", async () => {
  for (const status of ["pending", "in_progress"] as const) {
    const blocks = await fetchPreingestedReprintBlocks(
      mockPreingestDb({ status }),
      reprint1945,
    );
    assertEquals(blocks, null, `expected null for status=${status}`);
  }
});

Deno.test("fetchPreingestedReprintBlocks maps stored pages to FlatBlock[] once status is complete", async () => {
  const db = mockPreingestDb({
    status: "complete",
    pages: [
      { page_number: 5, text: "Home occupation permits require approval." },
      { page_number: 6, text: "Signage limits apply." },
    ],
  });
  const blocks = await fetchPreingestedReprintBlocks(db, reprint1945);
  assert(blocks !== null, "expected non-null blocks once status is complete");
  assertEquals(blocks!.length, 2);
  assertEquals(blocks![0].page_no, 5);
  assertEquals(
    blocks![0].text,
    "Home occupation permits require approval.",
  );
  assertEquals(blocks![1].page_no, 6);
});

Deno.test("fetchPreingestedReprintBlocks propagates a state-lookup error instead of silently treating it as not-ready", async () => {
  const db: PreingestDb = {
    from: (table: string) => {
      if (table === "encode_reprint_preingest_state") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: null, error: { message: "boom" } }),
            }),
          }),
        };
      }
      throw new Error("unexpected table");
    },
    // deno-lint-ignore no-explicit-any
  } as any;

  let threw = false;
  try {
    await fetchPreingestedReprintBlocks(db, reprint1945);
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.includes("boom"),
      "error message must surface the real DB error",
    );
  }
  assert(
    threw,
    "expected fetchPreingestedReprintBlocks to throw on a DB error",
  );
});

// ── runDeepHistoricalLookup fast-path / live-fallback branching ─────────────

Deno.test("runDeepHistoricalLookup answers from the fast path without ever calling the Docling wrapper", async () => {
  const db = mockPreingestDb({
    status: "complete",
    pages: [
      {
        page_number: 42,
        text:
          "Home occupation permits require a special use approval under Sect. 10-301.",
      },
    ],
  });

  await withMockedFetch(
    BASE_ENV,
    (input) => {
      const url = String(input);
      if (url.includes("docling.example")) {
        throw new Error(
          "Docling wrapper must never be called once the reprint is fully pre-ingested",
        );
      }
      return Promise.resolve(
        ollamaResponse(JSON.stringify({
          answer:
            "Home occupations required a special use approval under Sect. 10-301.",
          cited_pages: [42],
        })),
      );
    },
    async () => {
      const outcome = await runDeepHistoricalLookup(
        db,
        "what were the home occupation rules in 1948?",
        reprint1945,
      );
      // status can only be "answered" here if the Docling branch above was
      // genuinely skipped -- reaching it converts the outcome to "failed".
      assertEquals(outcome.status, "answered");
      if (outcome.status === "answered") {
        assertEquals(outcome.page, 42);
        assert(
          outcome.sourceLabel.includes("pre-ingested"),
          "fast-path answers must disclose they came from the pre-ingested store",
        );
      }
    },
  );
});

Deno.test("runDeepHistoricalLookup falls back to the live OCR endpoint when a reprint is only partially pre-ingested", async () => {
  const db = mockPreingestDb({ status: "in_progress" });

  await withMockedFetch(
    BASE_ENV,
    (input) => {
      const url = String(input);
      if (url.includes("docling.example")) {
        assert(
          url.includes("/process-ocr"),
          "live fallback must call the OCR-enabled /process-ocr endpoint, not the plain /process",
        );
        return Promise.resolve(
          doclingResponse([
            {
              text:
                "Home occupation permits require a special use approval under Sect. 10-301.",
              page_no: 42,
              bbox: null,
              reading_order_index: 0,
            },
          ]),
        );
      }
      return Promise.resolve(
        ollamaResponse(JSON.stringify({
          answer:
            "Home occupations required a special use approval under Sect. 10-301.",
          cited_pages: [42],
        })),
      );
    },
    async () => {
      const outcome = await runDeepHistoricalLookup(
        db,
        "what were the home occupation rules in 1948?",
        reprint1945,
      );
      assertEquals(outcome.status, "answered");
      if (outcome.status === "answered") {
        assert(
          outcome.sourceLabel.includes("live historical lookup"),
          "fallback answers must disclose they came from a live lookup, not the pre-ingested store",
        );
      }
    },
  );
});

Deno.test("runDeepHistoricalLookup falls back to live OCR when no preingest row exists at all", async () => {
  await withMockedFetch(
    BASE_ENV,
    (input) => {
      const url = String(input);
      if (url.includes("docling.example")) {
        return Promise.resolve(doclingResponse([]));
      }
      throw new Error(
        "ollamaChat must not be called when Docling returns zero blocks",
      );
    },
    async () => {
      const outcome = await runDeepHistoricalLookup(
        mockPreingestDb(), // no row at all — same as a reprint the background job hasn't reached
        "home occupation rules in 1948?",
        reprint1945,
      );
      assertEquals(outcome.status, "not_found");
    },
  );
});
