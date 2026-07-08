FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libgomp1 poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/user

COPY requirements.txt .
# requirements.txt sets --extra-index-url to the PyTorch CPU wheel index so
# torch and torchvision resolve together, from the same index, in this one
# pip pass -- splitting torch into its own install step caused an ABI
# mismatch (torch from the CPU index, torchvision from default PyPI) that
# broke `torchvision::nms` at import time.
RUN pip install --no-cache-dir -r requirements.txt

ENV DOCLING_ARTIFACTS_PATH=/home/user/.docling/models
ENV TOKENIZERS_PARALLELISM=false

# Constructing a DocumentConverter (the old probe here) doesn't force a real
# model download -- it only lazily prepares the pipeline, so DOCLING_ARTIFACTS_PATH
# ended up pointing at an incomplete folder and every /process request failed at
# runtime with "artifacts_path ... is not valid ... must point to a folder
# containing all models required by the pipeline". docling-tools' own `models
# download` subcommand is docling's documented mechanism for actually populating
# a local artifacts folder ahead of time (respects DOCLING_ARTIFACTS_PATH).
RUN docling-tools models download
# Cheap sanity check that the import chain still works post-download (mirrors
# app.py's actual converter construction).
RUN python3 -c "from docling.document_converter import DocumentConverter, PdfFormatOption; from docling.datamodel.base_models import InputFormat; from docling.datamodel.pipeline_options import PdfPipelineOptions; opts = PdfPipelineOptions(do_ocr=False, do_table_structure=False); DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}); print('Converter construction OK')"
RUN python3 -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('thenlper/gte-small'); print('Embedding model pre-downloaded OK')"

COPY app.py .

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
