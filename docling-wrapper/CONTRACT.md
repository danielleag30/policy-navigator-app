# API Contract — Docling Wrapper

Canonical schema for the Policy Navigator Docling wrapper deployed on Hugging Face Spaces.
This contract is referenced by the `ingest-pdf` Supabase Edge Function.

## Base URL

```
https://danielleag30-policy-navigator-docling.hf.space
```

Set as `HF_SPACES_DOCLING_URL` in Vercel / `.env.local`.
Set keep-warm URL as `HF_SPACES_KEEPWARM_URL`:
```
https://danielleag30-policy-navigator-docling.hf.space/health
```

## Endpoints

### GET /health

Liveness probe. Returns 200 with `{"ok": true}` when the service is ready.

### POST /process

Convert a publicly-accessible PDF URL to an ordered array of text blocks.

#### Request

```json
{
  "url": "https://example.gov/document.pdf"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | ✅ | Publicly-accessible PDF URL. Redirects followed. 120 s timeout. |

#### Response 200

```json
{
  "blocks": [TextBlock],
  "block_count": 42,
  "docling_version": "2.x.x"
}
```

#### TextBlock schema

```json
{
  "text": "string — non-empty, whitespace-stripped",
  "page_no": 1,
  "bbox": {
    "x0": 72.0,
    "y0": 700.0,
    "x1": 540.0,
    "y1": 720.0
  },
  "reading_order_index": 0
}
```

| Field | Type | Nullable | Description |
|-------|------|----------|-------------|
| `text` | string | no | Extracted text content, stripped. Never empty. |
| `page_no` | integer | yes | 1-indexed page number, or null if unavailable. |
| `bbox` | object | yes | Bounding box in PDF points, or null if unavailable. |
| `bbox.x0` | float | — | Left edge (Docling `prov[0].bbox.l`) |
| `bbox.y0` | float | — | Top edge (Docling `prov[0].bbox.t`) |
| `bbox.x1` | float | — | Right edge (Docling `prov[0].bbox.r`) |
| `bbox.y1` | float | — | Bottom edge (Docling `prov[0].bbox.b`) |
| `reading_order_index` | integer | no | 0-based index in document reading order. |

#### Error responses

| Status | Body | Condition |
|--------|------|-----------|
| 422 | `{"detail": [...]}` | Missing or invalid `url` field |
| 500 | `{"detail": "string"}` | Fetch failure or Docling conversion error |

No stack traces are included in error responses.

### POST /process-ocr

OCR-enabled variant of `/process` — **opt-in only**, a separate route from
`/process`. `/process` itself is completely unchanged (`do_ocr=False`
always) and remains the only endpoint the recurring ingest-orchestrator poll
path calls; it is already near its CPU/timeout ceiling on ordinary
text-native PDFs in production and must never silently run OCR.

Added for the deep-historical pre-ingestion job
(`supabase/functions/encode-reprint-preingest`) and its live-query fallback
(`query-pipeline/_deep-historical.ts`): all 18 EnCode historical
zoning-ordinance reprints are scanned images with zero embedded text, so
`/process`'s `do_ocr=False` always returns 0 blocks for them.

#### Request

```json
{
  "url": "https://example.gov/scanned-document.pdf",
  "page_start": 5,
  "page_end": 7
}
```

| Field | Type | Required | Description |
|-------|------|----------|--------------|
| `url` | string | ✅ | Publicly-accessible PDF URL. Redirects followed. 120 s fetch timeout. |
| `page_start` | integer | no | 1-indexed, inclusive. Must be provided together with `page_end` or not at all. |
| `page_end` | integer | no | 1-indexed, inclusive. Must be >= `page_start`. |

When `page_start`/`page_end` are provided, the source PDF is first sliced
with poppler-utils (`pdfseparate` + `pdfunite`) so the OCR pass only runs
over the requested pages. Omit both to OCR the entire document.

#### Response 200

Same shape as `/process`'s response (see above). `page_no` values always
reflect the ORIGINAL document's page numbers, even when a page range was
sliced before conversion (a sliced sub-PDF's internal numbering restarts at
1; the wrapper remaps it back).

#### Error responses

| Status | Body | Condition |
|--------|------|-----------|
| 422 | `{"detail": "..."}` | Missing `url`; only one of `page_start`/`page_end` given; `page_start` > `page_end` |
| 500 | `{"detail": "string"}` | Fetch failure, poppler-utils slicing failure, or Docling conversion error |

### POST /pdfinfo

Cheap page-count lookup via poppler-utils `pdfinfo` — no Docling/OCR work at
all. Lets a caller size a page-chunk loop against `/process-ocr` without
paying for a conversion pass first.

#### Request

```json
{"url": "https://example.gov/scanned-document.pdf"}
```

#### Response 200

```json
{"pages": 42}
```

#### Error responses

| Status | Body | Condition |
|--------|------|-----------|
| 422 | `{"detail": "..."}` | Missing `url` |
| 500 | `{"detail": "string"}` | Fetch failure or `pdfinfo` failure (corrupt PDF) |

### POST /embed

Embed a batch of texts with the gte-small sentence-transformers model.
Added for ordinance_provisions embedding (task 2-6 follow-up): runs as an
async HTTP call from the Edge Function instead of the in-process
`Supabase.ai.Session('gte-small')`, since Edge Function CPU-time budget does
not count time spent awaiting a fetch.

#### Request

```json
{
  "texts": ["Section 1. Purpose...", "Section 2. Definitions..."]
}
```

| Field | Type | Required | Description |
|-------|------|----------|--------------|
| `texts` | string[] | ✅ | 1-100 non-empty strings per request. |

#### Response 200

```json
{
  "embeddings": [[0.01, -0.02, ...], [0.03, 0.01, ...]],
  "model": "thenlper/gte-small",
  "dimensions": 384
}
```

| Field | Type | Description |
|-------|------|-------------|
| `embeddings` | float[][] | One 384-dimensional vector per input text, in input order. Mean-pooled, L2-normalized. |
| `model` | string | HF model id used. |
| `dimensions` | integer | Length of each embedding vector (384). |

#### Error responses

| Status | Body | Condition |
|--------|------|-----------|
| 422 | `{"detail": [...]}` | `texts` missing, empty, >100 items, or contains an empty/whitespace-only string |
| 500 | `{"detail": "string"}` | Model inference error |

## Versioning

`docling_version` in the response reflects the installed Docling library version.
The contract itself is versioned by this file in git.

## Implementation notes

- `/process`: OCR is **disabled** (`do_ocr=False`) — native PDF text extraction only.
- `/process-ocr`: OCR is **enabled** (`do_ocr=True`), opt-in only via this separate route.
- Table structure detection is **disabled** (`do_table_structure=False`) on both — CPU budget.
- Only `TextItem` instances from `iterate_items(with_groups=False)` are emitted.
- Empty-string blocks (after stripping) are silently dropped.
- Each converter instance (`/process`'s and `/process-ocr`'s) is shared across requests to its own route (single worker).
