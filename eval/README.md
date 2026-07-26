# Policy Navigator Eval Framework

Deterministic test runner for the `query-pipeline` Edge Function. Covers all eight eval categories defined in spec Section 11.

## Prerequisites

- [Deno](https://deno.com/) v1.40+ installed
- A deployed `query-pipeline` Edge Function (or local Supabase dev stack)

## Environment variables

Set the following before running:

```bash
export QUERY_PIPELINE_URL="https://<project-ref>.supabase.co/functions/v1/query-pipeline"
export SUPABASE_ANON_KEY="<your-anon-key>"
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<your-service-role-key>"
```

`SUPABASE_SERVICE_ROLE_KEY` is used only for the pre-run chunk ID verification step (reads chunk tables directly via PostgREST). It is never sent to the pipeline itself.

## Running the full suite

```bash
deno run --allow-net --allow-env --allow-read --allow-write eval/runner.ts
```

## Running a single category

```bash
deno run --allow-net --allow-env --allow-read --allow-write eval/runner.ts \
  --category temporal_correctness
```

Valid category values:

- `citation_accuracy_numeric`
- `citation_accuracy_textual`
- `temporal_correctness`
- `adversarial_near_miss`
- `refusal`
- `retrieval`
- `synthesis`
- `out_of_corpus`

## Other flags

| Flag | Default | Description |
|---|---|---|
| `--category <name>` | *(all)* | Run only cases in this category |
| `--batch-size <n>` | `20` | Cases per batch before pausing |
| `--batch-delay <ms>` | `30000` | Pause between batches in ms |
| `--cases-dir <path>` | `eval/cases` | Directory to load `.json` case files from |
| `--results-dir <path>` | `eval/results` | Directory to write results JSON |

## Re-running failed cases

Results are written to `eval/results/<timestamp>.json`. Each entry has a `status` field (`pass`, `fail`, `skipped`, `error`) and a `case_id`.

To re-run only failed cases:

1. Extract the failing `case_id` values from the results JSON.
2. Copy the corresponding case files into a temporary directory (e.g. `eval/cases-retry/`).
3. Run with `--cases-dir eval/cases-retry`.

## Handling missing chunk IDs

If the pre-run check warns that a `chunk_id` is not found in any chunk table, the affected cases are skipped. This usually means:

1. The referenced chunk was never ingested — run the ingest pipeline for the relevant source document.
2. The chunk was superseded and the ID changed — update the case file with the current chunk ID.
3. The Supabase project is paused — resume it and retry.

After re-ingesting, re-run the full suite. The pre-run check will pass if the chunk IDs now exist.

## Batch sizing guidance

The default of 20 cases per batch with a 30-second cooldown is intentionally conservative. The `query-pipeline` function calls the Ollama Cloud endpoint (gemma4:31b-cloud), which has no SLA and has documented monthly reliability incidents. Aggressive batching risks hitting rate limits or stacking timeouts.

- For local dev (Supabase local + Ollama local): `--batch-size 50 --batch-delay 5000`
- For production smoke tests (small subset): `--batch-size 5 --batch-delay 10000`
- For the full pre-launch run: keep defaults

## Results format

The runner writes a per-case results JSON to `eval/results/<run-start-timestamp>.json`
and **rewrites it after every case**, so a crash, rate-limit blowup, or Ctrl-C can
never leave a run with no durable per-case evidence (the 2026-07-22 baseline's
per-case results were lost exactly this way). Each record captures the actual
answer, the cited chunk ids, and the error (if any) — enough to attribute a
pass→fail flip after the fact instead of only bounding it.

```json
{
  "timestamp": "2026-07-25T02:50:06.000Z",
  "completed_at": "2026-07-25T04:41:00.000Z",
  "summary": {
    "total": 175,
    "ran": 168,
    "passed": 43,
    "overallPct": 26,
    "correctness": {
      "asserted": 90,
      "correct": 41,
      "pct": 46,
      "falseAssertionsWhereRefusalExpected": 5
    },
    "availability": { "expected": 148, "answered": 70, "refused": 78, "answeredPct": 47, "refusedPct": 53 }
  },
  "results": [
    {
      "case_id": "...",
      "category": "temporal_correctness",
      "status": "pass",
      "criteria_results": [
        { "criterion_id": "has_temporal_flag", "pass": true }
      ],
      "response_ms": 1234,
      "answer": "the actual pipeline answer text",
      "cited_chunk_ids": ["019f34ba-9207-7156-9105-8ca308feed9c"],
      "expects_answer": true,
      "refused": false,

      "gold_in_pool": true,
      "gold_rank_bm25": 14,
      "gold_rank_vector": 1,
      "pool_size": 277,
      "gold_pool_detail": [
        { "chunk_id": "019f34ba-...", "table": "ordinance_provisions", "rank_bm25": 14, "rank_vector": 1 }
      ]
    }
  ]
}
```

(The `summary` numbers above are illustrative, not a real run.)

### Correctness vs availability

A single pass rate conflates two **opposite** failures that this project weights
very differently under its correctness-over-availability policy:

- **Correctness** — of the cases where the system *asserted* an answer, how many
  were right and correctly cited. Every miss here is a false or miscited
  assertion — the **severe** failure class (target ≈ 100%). The
  `falseAssertionsWhereRefusalExpected` sub-count isolates the worst kind:
  asserting where a refusal was required.
- **Availability** — of the cases where an answer was *expected*, how often the
  system refused or fell through. Under the stated policy this is the **cheaper**
  failure: a refusal is not a false statement.

A case "expects an answer" unless it carries an `is_refusal` criterion. The
overall pass rate is still reported, clearly labelled as continuity-only.

### Retrieval-pool instrumentation ("pool echo")

The four `gold_*` / `pool_size` columns above are **additive** and are distinct
from whether the answer *cited* the gold. They record whether the expected gold
`chunk_id`(s) were in the retrieval **candidate pool** at all, and at what
per-arm rank — the prerequisite for measuring the §5.2.2 citation router.

- `gold_in_pool` — was any expected gold chunk in either arm's top-40 candidate
  pool (`gold_rank_bm25 !== null || gold_rank_vector !== null`)?
- `gold_rank_bm25` / `gold_rank_vector` — the gold's best (lowest) 1-based rank
  **within its own table's** BM25 / vector arm; `null` if that arm missed it.
- `pool_size` — distinct candidates actually returned across all arms/tables,
  keyed `{table}:{id}` exactly like the pipeline's RRF dedup.
- `gold_pool_detail` — per-gold-id table + per-arm rank, for auditability.
- `pool_echo_vector_error` / `arm_errors` — set only when the vector embed or a
  per-table RPC degraded (e.g. the ~4.5s `bm25_budget_indicators` tripping the 8s
  statement timeout under load — the pipeline degrades the same way). A pool with
  a hole is never silently read as a clean miss.

**Why this exists.** The `query-pipeline` HTTP response only exposes the ≤8
chunks the drafter *finally cited*, never the ~40-per-arm retrieval pool that RRF
merges. Without the pool, a failing case cannot be attributed to **retrieval**
(the gold never surfaced — a router/ranking problem) vs **post-retrieval** (it
surfaced and the judge/drafter dropped it). That gap is exactly how a prior
analysis overcounted "retrieval-blind" failures.

**How it stays faithful.** `eval/pool-echo.ts` reconstructs the pool by calling
the *same* `bm25_<table>` / `match_<table>` RPCs with the *same* arguments the
pipeline uses, and reads back the same per-table 1-based ranks. The vector arm's
query embedding comes from the project's other shipping embed path —
`generateEmbeddingsHttp` against the docling-wrapper `/embed` endpoint, which
serves the *same* `thenlper/gte-small` model with the *same* mean-pool +
L2-normalize as the pipeline's in-Edge `Supabase.ai.Session('gte-small')`. During
a live run the runner computes these columns for every case with a gold
`chunk_id` (set `HF_SPACES_DOCLING_URL` to enable the vector arm; without it, the
BM25 arm is still recorded and `pool_echo_vector_error` is set).

### Backfilling pool echo onto an existing run

To compute the retrieval split for a results file produced **before** this
instrumentation existed — without re-running the pipeline:

```bash
deno run --allow-net --allow-env --allow-read --allow-write \
  eval/pool-echo-backfill.ts \
  --results <path/to/results.json> \
  [--status-field status_tolerant] [--out <path>]
```

It uses the same `eval/pool-echo.ts` functions, pulling gold `chunk_id`s and
queries from `eval/cases` and pass/fail + cited chunks from the results file, and
prints the aggregate **surfaced (post-retrieval drop) vs blind (retrieval
problem)** split across the failing set.

Results files themselves are excluded from git via `.gitignore` (they are large);
the `eval/results/` directory is tracked via `.gitkeep`, and the runner recreates
the path on every run.
