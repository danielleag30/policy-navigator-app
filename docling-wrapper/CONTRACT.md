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

## Versioning

`docling_version` in the response reflects the installed Docling library version.
The contract itself is versioned by this file in git.

## Implementation notes

- OCR is **disabled** (`do_ocr=False`) — native PDF text extraction only.
- Table structure detection is **disabled** (`do_table_structure=False`) — CPU budget.
- Only `TextItem` instances from `iterate_items(with_groups=False)` are emitted.
- Empty-string blocks (after stripping) are silently dropped.
- The converter instance is shared across requests (single worker).
