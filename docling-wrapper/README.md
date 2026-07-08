---
title: Policy Navigator Docling Wrapper
emoji: 📄
colorFrom: blue
colorTo: indigo
sdk: docker
pinned: false
license: mit
---

# Policy Navigator — Docling Wrapper

FastAPI service that converts policy PDF documents to structured text blocks
using [Docling](https://github.com/DS4SD/docling) on CPU.

## Endpoints

### `GET /health`
Liveness check.

```json
{"ok": true}
```

### `POST /process`
Convert a PDF at `url` to an ordered list of text blocks.

**Request**
```json
{"url": "https://example.gov/policy.pdf"}
```

**Response**
```json
{
  "blocks": [
    {
      "text": "Section 1. Purpose...",
      "page_no": 1,
      "bbox": {"x0": 72.0, "y0": 700.0, "x1": 540.0, "y1": 720.0},
      "reading_order_index": 0
    }
  ],
  "block_count": 42,
  "docling_version": "2.x.x"
}
```

### `POST /embed`
Embed a batch of texts with `thenlper/gte-small` (mean-pooled, L2-normalized, 384d).

**Request**
```json
{"texts": ["Section 1. Purpose...", "Section 2. Definitions..."]}
```

**Response**
```json
{
  "embeddings": [[0.01, -0.02, "..."], [0.03, 0.01, "..."]],
  "model": "thenlper/gte-small",
  "dimensions": 384
}
```

See [CONTRACT.md](./CONTRACT.md) for the full API contract.

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `DOCLING_ARTIFACTS_PATH` | `/home/user/.docling/models` | Pre-downloaded model cache |
| `TOKENIZERS_PARALLELISM` | `false` | Suppress HuggingFace tokenizer warning |

Models (~1–2 GB) are pre-downloaded at Docker build time to avoid cold-start latency.
