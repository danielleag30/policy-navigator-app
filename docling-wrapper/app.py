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

Also serves POST /process-ocr and POST /pdfinfo — see their docstrings below.
Added for the deep-historical pre-ingestion job (policy-navigator repo,
supabase/functions/encode-reprint-preingest): all 18 EnCode historical
zoning-ordinance reprints (1941-2021) are pure scanned images with zero
embedded text, so /process's do_ocr=False always returns 0 blocks for them.
/process-ocr is a strictly opt-in, separate route — the default /process
endpoint below is completely unchanged (still do_ocr=False, still the only
endpoint the recurring ingest-orchestrator poll path calls) because it is
already running near its CPU/timeout ceiling on ordinary text-native PDFs in
production; there is zero room to silently slow it down for everyone by
sharing a converter or a do_ocr request flag on the same route.

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

  POST /process-ocr  {"url": "<publicly reachable PDF URL>", "page_start": <int?>, "page_end": <int?>}
  -> same response shape as /process, but produced with OCR enabled.

  POST /pdfinfo  {"url": "<publicly reachable PDF URL>"}
  -> {"pages": <int>}

  POST /embed  {"texts": ["<str>", ...]}
  -> {
       "embeddings": [[<float> x 384], ...],
       "model":      "thenlper/gte-small",
       "dimensions": 384
     }

  GET /health
  -> {"ok": true}

Design decisions:
  - /process: OCR disabled (do_ocr=False): free CPU tier; Fairfax PDFs are
    text-layer. Table structure disabled (do_table_structure=False):
    TableFormer is slow on CPU; text from table cells still emitted as
    TextItems.
  - /process-ocr: OCR enabled, table structure still disabled (same CPU
    rationale). Optional page_start/page_end (1-indexed, inclusive) slice the
    source PDF with poppler-utils (pdfseparate + pdfunite, already in the
    Dockerfile for this reason) before conversion, so the OCR pass — the
    expensive part — only ever runs over the requested pages. Returned
    page_no values are remapped back to the ORIGINAL document's page numbers
    (slicing resets a sub-PDF's page numbering to start at 1), so callers
    always get citation-accurate page numbers regardless of chunking.
  - /pdfinfo: poppler-utils `pdfinfo`, no Docling/OCR work at all — lets a
    caller size a page-chunk loop without paying for a conversion pass first.
  - Only TextItem subclasses emitted; TableItem/FigureItem silently skipped.
  - Models pre-downloaded at Docker build time (see Dockerfile).
  - TOKENIZERS_PARALLELISM=false suppresses HF warnings.
  - Embedding model (thenlper/gte-small) mirrors the dimensionality (384d)
    and pooling/normalization (mean pool + L2 normalize) of the
    Supabase.ai.Session('gte-small') call it replaces for ordinance_provisions,
    so existing stored vectors and new ones remain comparable.
"""

import glob
import io
import logging
import os
import pathlib
import re
import shutil
import subprocess
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

# Default converter instance shared across requests — the ONLY converter the
# default /process endpoint ever touches. do_ocr stays False here always.
_PDF_OPTIONS = PdfPipelineOptions(do_ocr=False, do_table_structure=False)
_CONVERTER = DocumentConverter(
    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=_PDF_OPTIONS)}
)

# Separate OCR-enabled converter instance for the opt-in /process-ocr route
# only. Kept as a distinct DocumentConverter (not a per-request flag on the
# shared instance above) so there is no code path by which the default
# /process route could ever end up running OCR.
_PDF_OPTIONS_OCR = PdfPipelineOptions(do_ocr=True, do_table_structure=False)
_CONVERTER_OCR = DocumentConverter(
    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=_PDF_OPTIONS_OCR)}
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


class ProcessOcrRequest(BaseModel):
    url: str
    # 1-indexed, inclusive. Both must be provided together or neither.
    page_start: Optional[int] = Field(None, ge=1)
    page_end: Optional[int] = Field(None, ge=1)


class PdfInfoRequest(BaseModel):
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


async def _fetch_pdf_bytes(url: str) -> bytes:
    """Download a PDF's raw bytes. Shared by /process, /process-ocr, /pdfinfo."""
    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(120.0, connect=15.0),
        ) as client:
            resp = await client.get(url)
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
    return raw


def _flatten_blocks(doc, page_offset: int = 0) -> list[dict]:
    """Flatten a DoclingDocument to the flat text-block array both /process
    and /process-ocr return. page_offset shifts every reported page_no —
    used by /process-ocr when the source PDF was sliced with poppler-utils
    before conversion (a sliced sub-PDF's internal page numbering always
    restarts at 1, so the offset restores the ORIGINAL document's page
    numbers)."""
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

        if page_no is not None:
            page_no += page_offset

        blocks.append({"text": text, "page_no": page_no,
                        "bbox": bbox, "reading_order_index": idx})
        idx += 1
    return blocks


def _slice_pdf_pages(src_path: str, page_start: int, page_end: int) -> str:
    """Extract pages [page_start, page_end] (1-indexed, inclusive) from
    src_path into a new temp PDF using poppler-utils (pdfseparate splits each
    requested page into its own single-page file numbered by its ORIGINAL
    page number; pdfunite reassembles the selected files back into one PDF
    in order). Returns the path to the new temp PDF; caller must unlink it.
    Raises RuntimeError on any poppler failure (bad range, corrupt PDF)."""
    tmp_dir = tempfile.mkdtemp(prefix="pdfslice_")
    try:
        pattern = os.path.join(tmp_dir, "page-%d.pdf")
        try:
            subprocess.run(
                ["pdfseparate", "-f", str(page_start), "-l", str(page_end),
                 src_path, pattern],
                check=True, capture_output=True, timeout=120,
            )
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr.decode("utf-8", "replace") if exc.stderr else ""
            raise RuntimeError(
                f"pdfseparate failed for pages {page_start}-{page_end}: {stderr[:400]}"
            ) from exc

        page_files = sorted(
            glob.glob(os.path.join(tmp_dir, "page-*.pdf")),
            key=lambda p: int(re.search(r"page-(\d+)\.pdf$", p).group(1)),
        )
        if not page_files:
            raise RuntimeError(
                f"pdfseparate produced no pages for range {page_start}-{page_end} "
                "(range may be out of bounds)"
            )

        out_fd, out_path = tempfile.mkstemp(suffix=".pdf")
        os.close(out_fd)
        if len(page_files) == 1:
            shutil.copyfile(page_files[0], out_path)
        else:
            try:
                subprocess.run(
                    ["pdfunite", *page_files, out_path],
                    check=True, capture_output=True, timeout=120,
                )
            except subprocess.CalledProcessError as exc:
                stderr = exc.stderr.decode("utf-8", "replace") if exc.stderr else ""
                raise RuntimeError(f"pdfunite failed: {stderr[:400]}") from exc
        return out_path
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _pdf_page_count(src_path: str) -> int:
    """Total page count via poppler-utils `pdfinfo` — no Docling/OCR work."""
    try:
        result = subprocess.run(
            ["pdfinfo", src_path], check=True, capture_output=True, timeout=30,
        )
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", "replace") if exc.stderr else ""
        raise RuntimeError(f"pdfinfo failed: {stderr[:400]}") from exc
    text = result.stdout.decode("utf-8", "replace")
    match = re.search(r"^Pages:\s+(\d+)", text, re.MULTILINE)
    if not match:
        raise RuntimeError("pdfinfo output did not include a Pages: line")
    return int(match.group(1))


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
    """Download PDF, parse with Docling (do_ocr=False, always), return flat
    block array. Default endpoint — the recurring ingest-orchestrator poll
    path calls only this route; never touched by the OCR work below."""
    log.info(f"Processing: {req.url}")
    _validate_url(req.url)

    raw = await _fetch_pdf_bytes(req.url)
    log.info(f"Fetched {len(raw):,} bytes")

    # Parse with Docling — write to temp file; Path is the only guaranteed-stable
    # input type across Docling 2.x (BytesIO and DocumentStream both broke in 2.104.0)
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

    blocks = _flatten_blocks(doc)

    ver = importlib.metadata.version("docling")
    log.info(f"Emitting {len(blocks)} blocks (Docling {ver})")
    return JSONResponse({"blocks": blocks, "docling_version": ver,
                         "block_count": len(blocks)})


@app.post("/process-ocr")
async def process_document_ocr(req: ProcessOcrRequest):
    """OCR-enabled document conversion — opt-in only, separate route from
    /process (see module docstring / file header for why). Built for the
    deep-historical pre-ingestion job and its live-query fallback, both of
    which need real OCR: all 18 EnCode historical zoning-ordinance reprints
    are scanned images with zero embedded text, so /process's do_ocr=False
    always returns 0 blocks for them.

    Optional page_start/page_end (1-indexed, inclusive, must be given
    together) bound the OCR pass to a page range: the source PDF is sliced
    with poppler-utils first so Docling's OCR pipeline — the CPU-expensive
    part — only runs over the requested pages, not the whole document.
    Returned page_no values are remapped back to the ORIGINAL document's page
    numbers regardless of slicing.
    """
    log.info(f"Processing (OCR): {req.url}")
    _validate_url(req.url)

    if (req.page_start is None) != (req.page_end is None):
        raise HTTPException(status_code=422,
            detail="page_start and page_end must be provided together")
    if req.page_start is not None and req.page_start > req.page_end:
        raise HTTPException(status_code=422,
            detail="page_start must be <= page_end")

    raw = await _fetch_pdf_bytes(req.url)
    log.info(f"Fetched {len(raw):,} bytes")

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
    sliced_path: Optional[str] = None
    try:
        with os.fdopen(tmp_fd, "wb") as f:
            f.write(raw)

        convert_path = tmp_path
        page_offset = 0
        if req.page_start is not None:
            try:
                sliced_path = _slice_pdf_pages(tmp_path, req.page_start, req.page_end)
            except RuntimeError as exc:
                raise HTTPException(status_code=500, detail=str(exc))
            convert_path = sliced_path
            page_offset = req.page_start - 1

        try:
            result = _CONVERTER_OCR.convert(pathlib.Path(convert_path))
            doc = result.document
        except Exception as exc:
            log.error(f"Docling OCR error: {exc}", exc_info=True)
            raise HTTPException(status_code=500,
                detail=f"Docling error: {type(exc).__name__}: {exc}")

        blocks = _flatten_blocks(doc, page_offset=page_offset)
    finally:
        for p in (tmp_path, sliced_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass

    ver = importlib.metadata.version("docling")
    log.info(f"Emitting {len(blocks)} OCR blocks (Docling {ver})")
    return JSONResponse({"blocks": blocks, "docling_version": ver,
                         "block_count": len(blocks)})


@app.post("/pdfinfo")
async def pdf_info(req: PdfInfoRequest):
    """Cheap page-count lookup (poppler-utils `pdfinfo`) — no Docling/OCR
    work at all. Lets a caller (the deep-historical pre-ingestion job) size
    its page-chunk loop without paying for a conversion pass first."""
    _validate_url(req.url)
    raw = await _fetch_pdf_bytes(req.url)

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
    try:
        with os.fdopen(tmp_fd, "wb") as f:
            f.write(raw)
        try:
            pages = _pdf_page_count(tmp_path)
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc))
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    return JSONResponse({"pages": pages})
