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

```json
{
  "timestamp": "2026-06-24T12:00:00.000Z",
  "results": [
    {
      "case_id": "...",
      "category": "temporal_correctness",
      "status": "pass",
      "criteria_results": [
        { "criterion_id": "has_temporal_flag", "pass": true }
      ],
      "response_ms": 1234
    }
  ]
}
```

Results files are excluded from git via `.gitignore`.
