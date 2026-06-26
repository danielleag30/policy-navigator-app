"""
Policy Navigator — Docling Wrapper
HF Space: danielleag30/policy-navigator-docling

Accepts a document URL via POST /process and returns a flat JSON array of
text blocks in reading order. The Edge Function (task 2-3) depends on this
stable contract; it never touches the raw DoclingDocument structure.

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

  GET /health
  -> {"ok": true}

Design decisions:
  - OCR disabled (do_ocr=False): free CPU tier; Fairfax PDFs are text-layer.
  - Table structure disabled (do_table_structure=False): TableFormer is slow
    on CPU; text from table cells still emitted as TextItems.
  - Only TextItem subclasses emitted; TableItem/FigureItem silently skipped.
  - Models pre-downloaded at Docker build time (see Dockerfile).
  - TOKENIZERS_PARALLELISM=false suppresses HF warnings.
"""

import io
import logging
import os
import pathlib
import tempfile
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# Suppress HuggingFace tokenizer parallelism warning on CPU
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("DOCLING_ARTIFACTS_PATH", "/home/user/.docling/models")

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

app = FastAPI(
    title="Policy Navigator — Docling Wrapper",
    version=docling.__version__,
)


class ProcessRequest(BaseModel):
    url: str



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

    ver = docling.__version__
    log.info(f"Emitting {len(blocks)} blocks (Docling {ver})")
    return JSONResponse({"blocks": blocks, "docling_version": ver,
                         "block_count": len(blocks)})
