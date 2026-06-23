# Policy Navigator Edge Functions API Contract

Task 2-21b contract verification. This document describes the implemented Edge
Function request and response shapes from the function source, including the
completed query-pipeline response assembly, change-detection, and reconciliation
task branches.

All functions return the shared envelope from `_shared/response.ts`:

```ts
type SuccessEnvelope<T> = { ok: true; data: T };
type ErrorEnvelope = { ok: false; error: { code: ErrorCode; message: string } };
```

Error codes and default status values:

| Error code | Default status |
| --- | ---: |
| `RATE_LIMITED` | 429 |
| `OLLAMA_EXHAUSTED` | 503 |
| `INGESTION_FAILED` | 500 |
| `NOT_FOUND` | 404 |
| `UNAUTHORIZED` | 401 |

---

## query-pipeline

**Path:** `/functions/v1/query-pipeline`
**Method:** `POST`
**Auth:** Supabase Edge Function JWT enforcement.

Runs the query pipeline: rate limit, query embedding, BM25/vector retrieval, RRF
merge, ancestor enrichment, temporal judge, FK traversal/completeness check,
answer drafting, conditional verification/correction, response assembly, and
request logging.

### Request

```json
{
  "query": "string (required, non-empty)",
  "context": {
    "optional": "opaque client context; currently ignored by the handler"
  }
}
```

### Success

`data` is `QueryResponseData` from `_shared/types.ts`.

```json
{
  "ok": true,
  "data": {
    "answer": "Generated answer text with formatted inline citations, or \"not in the documents\".",
    "citations": [
      {
        "chunk_id": "uuid",
        "source_url": "https://...",
        "source_title": "Document title",
        "page_number": 12,
        "bbox": null,
        "retrieved_at": "2026-06-01T00:00:00.000Z",
        "formatted": "[Document title, page 12, retrieved 2026-06-01]",
        "rank": 1
      }
    ],
    "citationMap": {
      "Exact claim text from the drafted answer": {
        "chunk_id": "uuid",
        "page": 12,
        "bbox": null
      }
    },
    "chunkText": {
      "uuid": "Full cited chunk text"
    },
    "temporalFlag": false,
    "amendmentCaveat": null,
    "pendingChangeNotice": null,
    "incompleteSearchWarning": false,
    "freshnessTimestamp": "2026-06-01T00:00:00.000Z",
    "freshness": "Sources current as of 2026-06-01",
    "caveats": []
  }
}
```

Field notes:

- `citations` is ordered by cited chunk relevance after answer assembly.
- `citationMap` is keyed by exact claim text from the draft answer.
- `chunkText` is keyed by `chunk_id` and contains only cited chunks.
- `bbox`, `page_number`, `retrieved_at`, `freshnessTimestamp`, and `freshness`
  are nullable when source metadata is unavailable.
- `caveats` includes applicable amendment, pending-change, incomplete-version,
  and verifier caveats.

### Incomplete Search Success

If the maximum RRF score is below `INCOMPLETE_SEARCH_FLOOR`, the function still
returns `200` with the full response shape and `incompleteSearchWarning: true`.

```json
{
  "ok": true,
  "data": {
    "answer": "",
    "citations": [],
    "citationMap": {},
    "chunkText": {},
    "temporalFlag": false,
    "amendmentCaveat": null,
    "pendingChangeNotice": null,
    "incompleteSearchWarning": true,
    "freshnessTimestamp": null,
    "freshness": null,
    "caveats": []
  }
}
```

### Errors

| Status | Error code | Condition |
| ---: | --- | --- |
| 405 | `NOT_FOUND` | Method is not `POST`. |
| 400 | `NOT_FOUND` | Body is invalid JSON. |
| 400 | `NOT_FOUND` | `query` is missing, not a string, or empty after trim. |
| 429 | `RATE_LIMITED` | IP exceeded the current rate-limit window. |
| 503 | `INGESTION_FAILED` | Rate-limit bucket write or request-log write failed. |
| 500 | `INGESTION_FAILED` | Query embedding failed. |
| 500 | `INGESTION_FAILED` | FK traversal failed while loading linked vote/decision context. |
| 503 | `OLLAMA_EXHAUSTED` | Temporal judge, answer drafter, verifier, or correction pass exhausted Ollama retries or returned unusable output. |

---

## ingest-orchestrator

**Path:** `/functions/v1/ingest-orchestrator`
**Method:** `POST`
**Auth:** Service role token. Intended for pg_cron via
`private.cron_invoke_edge_function`, not direct client use.

Processes one `pending_ingestions` row. PDF source types go through fetch,
deduplication, Docling, chunking, extraction, embeddings, and finalization.
`municode_api` source rows go through Municode ingestion, ordinance embeddings,
pending-code-change overlap detection, and reconciliation triggering.

### Request

```json
{
  "pending_ingestion_id": "uuid"
}
```

### Success

Already claimed, done, failed, skipped, or missing pending row:

```json
{
  "ok": true,
  "data": {
    "skipped": true,
    "reason": "not_pending"
  }
}
```

AI Session unavailable, deferred without consuming retry budget:

```json
{
  "ok": true,
  "data": {
    "status": "deferred",
    "reason": "ai_session_unavailable"
  }
}
```

Duplicate PDF or Municode content already ingested:

```json
{
  "ok": true,
  "data": {
    "status": "skipped",
    "document_id": "uuid"
  }
}
```

PDF ingestion completed:

```json
{
  "ok": true,
  "data": {
    "status": "done",
    "document_id": "uuid",
    "chunk_count": 47
  }
}
```

Municode ingestion completed:

```json
{
  "ok": true,
  "data": {
    "status": "done",
    "document_id": "uuid",
    "provision_count": 123
  }
}
```

### Errors

| Status | Error code | Condition |
| ---: | --- | --- |
| 405 | `NOT_FOUND` | Method is not `POST`. |
| 400 | `INGESTION_FAILED` | Body is invalid JSON. |
| 400 | `INGESTION_FAILED` | `pending_ingestion_id` is missing. |
| 500 | `INGESTION_FAILED` | Pending ingestion lookup failed. |
| 500 | `INGESTION_FAILED` | Failed to claim the processing slot. |
| 500 | `INGESTION_FAILED` | Ingestion failed and was reset to `pending` for retry. |
| 500 | `INGESTION_FAILED` | Maximum attempts reached and row was marked `failed`. |

---

## change-detection

**Path:** `/functions/v1/change-detection`
**Method:** `POST`
**Auth:** Service role token. Intended for scheduled invocation.

Scans `supabase/config/seed-sources.json`, checks watched source URLs, creates
`pending_ingestions` rows when content changes, writes stale/source-error alerts,
checks the latest Municode supplement job, and attempts to trigger
`reconciliation` when a new Municode job is detected.

### Request

No request body is read.

### Success

```json
{
  "ok": true,
  "data": {
    "scanned_urls": 5,
    "pending_ingestions_created": 1,
    "active_ingestions_skipped": 0,
    "last_checked_updates": 4,
    "skipped_invalid_seeds": 0,
    "stale_alerts_created": 0,
    "municode": {
      "checked": true,
      "job_id": "12345",
      "previous_job_id": "12344",
      "pending_ingestion_id": "uuid",
      "reconciliation_triggered": true
    },
    "errors": [],
    "results": [
      {
        "url": "https://...",
        "doc_type": "budget_pdf",
        "action": "pending_ingestion_created",
        "pending_ingestion_id": "uuid",
        "document_id": "uuid",
        "message": "optional detail"
      }
    ]
  }
}
```

`results[].doc_type` is one of `budget_pdf`, `bos_minutes`, `bos_summary`,
`ordinance`, or `municode_api`.

`results[].action` is one of:

- `pending_ingestion_created`
- `active_ingestion_exists`
- `last_checked_updated`
- `skipped_invalid_seed`
- `error`

`municode.checked` is `false` only when the Municode check did not complete.
`municode.job_id`, `previous_job_id`, and `pending_ingestion_id` are nullable.

### Errors

| Status | Error code | Condition |
| ---: | --- | --- |
| 405 | `NOT_FOUND` | Method is not `POST`. |
| 500 | `INGESTION_FAILED` | Fatal setup, seed validation, stale-alert, or summary failure. |

Per-URL and Municode scan failures are normally captured in `data.results`,
`data.errors`, and pending alerts while the function still returns `200`.

---

## reconciliation

**Path:** `/functions/v1/reconciliation`
**Method:** `POST`
**Auth:** Service role token. Called by `change-detection` or manually by an
operator.

Compares pending code changes against current ordinance provisions using Ollama,
writes `code_reconciliation_logs`, marks matched pending changes as codified,
and creates alerts for partial matches or mismatches.

### Request

```json
{
  "supplement_job_id": "string (required)",
  "pending_ingestion_id": "uuid (accepted when sent by change-detection; not read by handler)"
}
```

### Success

```json
{
  "ok": true,
  "data": {
    "reconciled": 2,
    "skipped": 1,
    "no_provision_found": 0,
    "results": [
      {
        "pending_code_change_id": "uuid",
        "ordinance_provision_id": "uuid",
        "result": "matched",
        "skipped": false
      },
      {
        "pending_code_change_id": "uuid",
        "error": "Pair-specific failure message"
      }
    ]
  }
}
```

`result` is one of `matched`, `partial_match`, `mismatch`, or `not_found`.
Duplicate log rows caused by concurrent runs are counted as `skipped`.
Pair-specific failures are included in `results` and do not fail the whole
request.

If there are no pending code changes, the success shape is the same with all
counts set to `0` and `results: []`.

### Errors

| Status | Error code | Condition |
| ---: | --- | --- |
| 405 | `NOT_FOUND` | Method is not `POST`. |
| 400 | `INGESTION_FAILED` | Body is invalid JSON. |
| 400 | `INGESTION_FAILED` | `supplement_job_id` is missing or not a string. |
| 500 | `INGESTION_FAILED` | Failed to load pending code changes. |
| 500 | `INGESTION_FAILED` | Failed to load current ordinance provisions. |
| 500 | `INGESTION_FAILED` | Fatal reconciliation failure outside a pair-specific comparison. |

---

## keepalive-health

**Path:** `/functions/v1/keepalive-health`
**Method:** Any method; the handler ignores the method.
**Auth:** Public. This function is intentionally excluded from the pre-launch
auth lockdown and is used by keep-alive pings.

### Request

No body required.

### Success

```json
{
  "ok": true,
  "data": {
    "alive": true,
    "ts": "2026-06-23T12:34:56.789Z"
  }
}
```

### Errors

| Status | Error code | Condition |
| ---: | --- | --- |
| 500 | `INGESTION_FAILED` | Supabase `ping()` RPC failed. |
