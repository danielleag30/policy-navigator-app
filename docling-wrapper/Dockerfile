FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libgomp1 poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/user

COPY requirements.txt .
# CPU-only torch first: sentence-transformers' unpinned torch dependency
# would otherwise pull the default (CUDA) wheel, which is ~2GB heavier and
# useless on the free CPU-only Spaces tier.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
    && pip install --no-cache-dir -r requirements.txt

ENV DOCLING_ARTIFACTS_PATH=/home/user/.docling/models
ENV TOKENIZERS_PARALLELISM=false

RUN python3 -c "from docling.document_converter import DocumentConverter; from docling.pipeline.standard_pdf_pipeline import PdfPipelineOptions; opts = PdfPipelineOptions(do_ocr=False, do_table_structure=False); DocumentConverter(pdf_pipeline_options=opts); print('Models pre-downloaded OK')"
RUN python3 -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('thenlper/gte-small'); print('Embedding model pre-downloaded OK')"

COPY app.py .

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
