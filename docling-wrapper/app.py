"""
Policy Navigator — Docling Wrapper
HF Space: danielleag30/policy-navigator-docling

Accepts a document URL via POST /process and returns a flat JSON array of
text blocks in reading order. The Edge Function (task 2-3) depends on this
stable contract; it never touches the raw DoclingDocument structure.

Also serves POST /embed: text-in, vector-out embedding generation via the
gte-small sentence-transformers model. Added so ordinance_provisions
embedding (task 2-6) can run as an async HTTP call instead of the in-process
Supabase.ai.Session('gte-small') — Edge Function CPU-time budget only counts
CPU-bound work, not time spent awaiting a fetch(), so moving embedding
generation here removes the ~2s CPU ceiling that was throttling that path to
1-3 rows per invocation against real ordinance content.

CONTRACT (see CONTRACT.md):
  POST /process  {"url": "<publicly reachable PDF URL>"}
  -> {
       "blocks": [
         {
           "text":                <str>,
           "page_no":             <int | null>,
           "bbox":                {"x0": f, "y0": f, "x1": f, "y1": f} | null,
           "reading_order_index": <int>
         }
       ],
       "docling_version": "<str>",
       "block_count":     <int>
     }

  POST /embed  {"texts": ["<str>", ...]}
  -> {
       "embeddings": [[<float> x 384], ...],
       "model":      "thenlper/gte-small",
       "dimensions": 384
     }

  GET /health
  -> {"ok": true}

Design decisions:
  - OCR disabled (do_ocr=False): free CPU tier; Fairfax PDFs are text-layer.
  - Table structure disabled (do_table_structure=False): TableFormer is slow
    on CPU; text from table cells still emitted as TextItems.
  - Only TextItem subclasses emitted; TableItem/FigureItem silently skipped.
  - Models pre-downloaded at Docker build time (see Dockerfile).
  - TOKENIZERS_PARALLELISM=false suppresses HF warnings.
  - Embedding model (thenlper/gte-small) mirrors the dimensionality (384d)
    and pooling/normalization (mean pool + L2 normalize) of the
    Supabase.ai.Session('gte-small') call it replaces for ordinance_provisions,
    so existing stored vectors and new ones remain comparable.
"""

import io
import logging
import os
import pathlib
import tempfile
import importlib.metadata
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

# Suppress HuggingFace tokenizer parallelism warning on CPU
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# No DOCLING_ARTIFACTS_PATH override: `docling-tools models download` (see
# Dockerfile) downloads into docling's own default cache dir
# (~/.cache/docling/models), and leaving this unset lets DocumentConverter
# resolve that same default at runtime -- pointing it at a different path
# here previously left it looking at an empty directory.

import docling  # noqa: E402
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat
try:
    from docling.datamodel.pipeline_options import PdfPipelineOptions
except ImportError:
    from docling.pipeline.standard_pdf_pipeline import PdfPipelineOptions  # type: ignore

# TextItem import with fallback for Docling internal module reorganisations
try:
    from docling_core.types.doc import TextItem
except ImportError:
    try:
        from docling.datamodel.document import TextItem  # type: ignore
    except ImportError:
        from docling.datamodel.base_models import TextItem  # type: ignore

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("docling-wrapper")

# Single converter instance shared across requests
_PDF_OPTIONS = PdfPipelineOptions(do_ocr=False, do_table_structure=False)
_CONVERTER = DocumentConverter(
    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=_PDF_OPTIONS)}
)

# Single embedding model instance shared across requests (see Dockerfile for
# the build-time pre-download that avoids paying this load cost per request).
_EMBED_MODEL_NAME = "thenlper/gte-small"
_EMBED_MODEL = SentenceTransformer(_EMBED_MODEL_NAME, device="cpu")
_EMBED_DIMENSIONS = _EMBED_MODEL.get_sentence_embedding_dimension()

# Caller (embedOrdinanceProvisionsBatched) sends one row at a time today, but
# the endpoint accepts a batch to avoid a request-per-text protocol. Bounded
# so a misbehaving caller can't hand this free CPU tier an unbounded batch.
MAX_EMBED_TEXTS_PER_REQUEST = 100

app = FastAPI(
    title="Policy Navigator — Docling Wrapper",
    version=importlib.metadata.version("docling"),
)


class ProcessRequest(BaseModel):
    url: str


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=MAX_EMBED_TEXTS_PER_REQUEST)



import ipaddress
import urllib.parse as _urlparse

_BLOCKED_NETS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local / GCP metadata
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
]


def _validate_url(url: str) -> None:
    """Raise HTTPException if url is not a safe public HTTPS URL."""
    parsed = _urlparse.urlparse(url)
    if parsed.scheme not in ("https",):
        raise HTTPException(status_code=422,
            detail="Only HTTPS URLs are accepted")
    hostname = parsed.hostname or ""
    if not hostname:
        raise HTTPException(status_code=422, detail="Missing hostname in URL")
    try:
        addr = ipaddress.ip_address(hostname)
        for net in _BLOCKED_NETS:
            if addr in net:
                raise HTTPException(status_code=422,
                    detail="Private/link-local addresses are not allowed")
    except ValueError:
        pass  # hostname is a domain name, not a bare IP — allow DNS resolution

@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/embed")
async def embed_texts(req: EmbedRequest):
    """Embed a batch of texts with gte-small; mean-pooled + L2-normalized."""
    if any(not t.strip() for t in req.texts):
        raise HTTPException(status_code=422, detail="texts must be non-empty strings")

    try:
        vectors = _EMBED_MODEL.encode(
            req.texts,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
    except Exception as exc:
        log.error(f"Embedding error: {exc}", exc_info=True)
        raise HTTPException(status_code=500,
            detail=f"Embedding error: {type(exc).__name__}: {exc}")

    return JSONResponse({
        "embeddings": vectors.tolist(),
        "model": _EMBED_MODEL_NAME,
        "dimensions": _EMBED_DIMENSIONS,
    })


@app.post("/process")
async def process_document(req: ProcessRequest):
    """Download PDF, parse with Docling, return flat block array."""
    log.info(f"Processing: {req.url}")
    _validate_url(req.url)

    # 1. Fetch bytes
    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(120.0, connect=15.0),
        ) as client:
            resp = await client.get(req.url)
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502,
            detail=f"HTTP {exc.response.status_code} fetching document")
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502,
            detail=f"{type(exc).__name__} fetching document")

    raw = resp.content
    if not raw:
        raise HTTPException(status_code=502, detail="Empty response body")
    log.info(f"Fetched {len(raw):,} bytes")

    # 2. Parse with Docling — write to temp file; Path is the only guaranteed-stable
    #    input type across Docling 2.x (BytesIO and DocumentStream both broke in 2.104.0)
    try:
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
        try:
            with os.fdopen(tmp_fd, "wb") as f:
                f.write(raw)
            result = _CONVERTER.convert(pathlib.Path(tmp_path))
            doc = result.document
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    except Exception as exc:
        log.error(f"Docling error: {exc}", exc_info=True)
        raise HTTPException(status_code=500,
            detail=f"Docling error: {type(exc).__name__}: {exc}")

    # 3. Flatten to text-block array in reading order
    blocks = []
    idx = 0
    for item, _level in doc.iterate_items(with_groups=False):
        if not isinstance(item, TextItem):
            continue
        text = (getattr(item, "text", "") or "").strip()
        if not text:
            continue

        page_no: Optional[int] = None
        bbox: Optional[dict] = None
        if item.prov:
            prov = item.prov[0]
            page_no = getattr(prov, "page_no", None)
            rb = getattr(prov, "bbox", None)
            if rb is not None:
                try:
                    # Docling: l=left, t=top, r=right, b=bottom (PDF origin=bottom-left)
                    # Exposed as x0/y0/x1/y1 for stable Edge Function contract
                    bbox = {"x0": float(rb.l), "y0": float(rb.t),
                            "x1": float(rb.r), "y1": float(rb.b)}
                except (AttributeError, TypeError):
                    bbox = None

        blocks.append({"text": text, "page_no": page_no,
                        "bbox": bbox, "reading_order_index": idx})
        idx += 1

    ver = importlib.metadata.version("docling")
    log.info(f"Emitting {len(blocks)} blocks (Docling {ver})")
    return JSONResponse({"blocks": blocks, "docling_version": ver,
                         "block_count": len(blocks)})
