# Policy Navigator Edge Functions API Contract

Task 2-21b contract verification. This document describes the implemented Edge
Function request and response shapes from the function source on this branch.
Only `query-pipeline`, `ingest-orchestrator`, and `keepalive-health` are present
in this worktree. The full query response assembly, `change-detection`, and
`reconciliation` contracts remain planned/pending merge.

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

Runs the current interim query pipeline: rate limit, query embedding,
BM25/vector retrieval, RRF merge, ancestor enrichment for ordinance candidates,
and an incomplete-search early exit.

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

On the normal success path, the current branch returns interim retrieval data:

```json
{
  "ok": true,
  "data": {
    "candidates": [
      {
        "id": "uuid",
        "table": "budget_chunks",
        "text": "Retrieved chunk text",
        "rrfScore": 0.03278688524590164,
        "source_url": "https://...",
        "source_title": "Document title",
        "page_number": 12,
        "ancestors": []
      }
    ],
    "total": 42
  }
}
```

Field notes:

- `candidates` contains the top eight RRF-ranked chunks after optional ancestor
  enrichment.
- `total` is the full ranked candidate count before the top-eight slice.
- `ancestors` is populated only for ordinance provision candidates when linked
  ancestor data can be loaded; it is otherwise an empty array.
- The full `QueryResponseData` answer/citation/freshness shape in
  `_shared/types.ts` is a planned contract and is not implemented on the normal
  success path of this branch.

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
| 503 | `INGESTION_FAILED` | Rate-limit bucket write failed. |
| 500 | `INGESTION_FAILED` | Query embedding failed. |

---

## ingest-orchestrator

**Path:** `/functions/v1/ingest-orchestrator`
**Method:** `POST`
**Auth:** Service role token. Intended for pg_cron via
`private.cron_invoke_edge_function`, not direct client use.

Processes one `pending_ingestions` row. PDF source types go through fetch,
deduplication, Docling, chunking, extraction, embeddings, and finalization.
`municode_api` source rows go through Municode ingestion, ordinance embeddings,
and pending-code-change overlap detection. Reconciliation triggering is planned
but is not implemented on this branch.

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
