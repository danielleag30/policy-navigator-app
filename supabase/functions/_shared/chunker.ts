/**
 * Sentence-aware chunker for Policy Navigator ingestion (task 2-3).
 *
 * Produces 512-token target chunks with ≤15% token overlap by complete
 * sentences from a flat Docling block array.  Each chunk carries full
 * provenance (page numbers, bounding boxes, reading-order indices).
 *
 * Token counting: word-based estimator (words * 1.3) — avoids runtime HF
 * model download that fails inside the Edge Function sandbox.
 */

// deno-lint-ignore-file no-explicit-any

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FlatBlock {
  text: string;
  page_no: number | null;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  reading_order_index: number;
}

export interface Chunk {
  text: string;
  token_count: number;
  page_number_start: number | null;
  page_number_end: number | null;
  bbox_start: { x0: number; y0: number; x1: number; y1: number } | null;
  bbox_end: { x0: number; y0: number; x1: number; y1: number } | null;
  reading_order_start: number;
  reading_order_end: number;
  /** True when this chunk shares sentences with the immediately preceding chunk. */
  overlap_prev: boolean;
  /** True when this chunk shares sentences with the immediately following chunk. */
  overlap_next: boolean;
}

// ── Token estimator ───────────────────────────────────────────────────────────

/**
 * Approximate BERT-style token count without any external model download.
 * English text averages ~1.3 WordPiece tokens per whitespace-delimited word.
 */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return Math.ceil(words.length * 1.3);
}

// ── Sentence splitter ─────────────────────────────────────────────────────────

/** Split text into sentences on punctuation boundaries. */
function splitSentences(text: string): string[] {
  // Split after . ! ? followed by whitespace, and on blank lines.
  const raw = text.split(/(?<=[.!?])\s+|\n{2,}/);
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ── Core chunker ──────────────────────────────────────────────────────────────

/**
 * Build token-bounded, sentence-aware chunks from a flat block array.
 *
 * @param blocks         Flat block array from the Docling wrapper.
 * @param targetTokens   Soft upper bound per chunk (default 512).
 * @param overlapFraction Fraction of targetTokens to repeat across boundaries (default 0.15).
 */
export async function chunkBlocks(
  blocks: FlatBlock[],
  targetTokens = 512,
  overlapFraction = 0.15,
): Promise<Chunk[]> {
  if (blocks.length === 0) return [];

  const maxOverlapTokens = Math.floor(targetTokens * overlapFraction); // ≤77

  // Sort blocks by reading order
  const sorted = [...blocks].sort(
    (a, b) => a.reading_order_index - b.reading_order_index,
  );

  // Explode blocks into sentences with provenance
  interface Sentence {
    text: string;
    tokenCount: number;
    page_no: number | null;
    bbox: { x0: number; y0: number; x1: number; y1: number } | null;
    reading_order_index: number;
  }

  const sentences: Sentence[] = [];
  for (const block of sorted) {
    for (const s of splitSentences(block.text)) {
      sentences.push({
        text: s,
        tokenCount: estimateTokens(s),
        page_no: block.page_no,
        bbox: block.bbox,
        reading_order_index: block.reading_order_index,
      });
    }
  }

  if (sentences.length === 0) return [];

  const chunks: Chunk[] = [];
  // overlapStartIdx[i] = index into sentences[] where chunk i's overlap begins
  const overlapStartIdx: number[] = [];

  let i = 0;
  while (i < sentences.length) {
    const chunkSents: Sentence[] = [];
    let tokenCount = 0;
    let j = i;

    while (j < sentences.length) {
      const s = sentences[j];
      if (tokenCount + s.tokenCount > targetTokens && chunkSents.length > 0) {
        break; // Would exceed limit; stop before this sentence
      }
      chunkSents.push(s);
      tokenCount += s.tokenCount;
      j++;
    }

    // Guard: if a single sentence exceeds targetTokens, include it anyway.
    if (chunkSents.length === 0 && j < sentences.length) {
      chunkSents.push(sentences[j]);
      tokenCount = sentences[j].tokenCount;
      j++;
    }
    if (chunkSents.length === 0) break;

    chunks.push({
      text: chunkSents.map((s) => s.text).join(" "),
      token_count: tokenCount,
      page_number_start: chunkSents[0].page_no,
      page_number_end: chunkSents[chunkSents.length - 1].page_no,
      bbox_start: chunkSents[0].bbox,
      bbox_end: chunkSents[chunkSents.length - 1].bbox,
      reading_order_start: chunkSents[0].reading_order_index,
      reading_order_end: chunkSents[chunkSents.length - 1].reading_order_index,
      overlap_prev: false,
      overlap_next: false,
    });
    overlapStartIdx.push(i);

    // Calculate how many trailing sentences fit within maxOverlapTokens
    let overlapTokenAcc = 0;
    let overlapCount = 0;
for (let k = chunkSents.length - 1; k >= 0; k--) {
      if (overlapTokenAcc + chunkSents[k].tokenCount <= maxOverlapTokens) {
        overlapTokenAcc += chunkSents[k].tokenCount;
        overlapCount++;
      } else {
        break;
      }
    }

    // Next chunk starts at j - overlapCount (but must advance past i)
    const nextI = Math.max(i + 1, j - overlapCount);
    i = nextI;
  }

  // Tag overlap_prev / overlap_next by comparing start indices
  for (let ci = 1; ci < chunks.length; ci++) {
    // If chunk ci starts before chunk (ci-1) ended it shares sentences
    if (chunks[ci].reading_order_start <= chunks[ci - 1].reading_order_end &&
        overlapStartIdx[ci] < overlapStartIdx[ci - 1] + /* sentinel */ 99999) {
      // Overlap is indicated by the fact that next chunk reuses sentences
      // from the tail of the previous chunk.
      const prevEndSentIdx = overlapStartIdx[ci - 1] +
        chunks[ci - 1].text.split(" ").length; // approximate
      if (overlapStartIdx[ci] < prevEndSentIdx) {
        chunks[ci].overlap_prev = true;
        chunks[ci - 1].overlap_next = true;
      }
    }
  }

  return chunks;
}

// ── Tokenizer validation ──────────────────────────────────────────────────────

/**
 * No-op validation shim — the HF tokenizer download was removed because it
 * fails inside the Edge Function sandbox.  Token counting now uses the
 * word-based estimateTokens() function above.
 */
export async function validateTokenizer(
  sampleText: string,
): Promise<{ valid: boolean; sampleTokenCount: number; note: string }> {
  const count = estimateTokens(sampleText);
  const note =
    `estimateTokens (words*1.3) counted ~${count} tokens for the ` +
    `${sampleText.length}-char sample. HF model download removed — ` +
    `Edge Function sandbox cannot fetch model weights at runtime.`;

  console.log("[chunker] token estimator:", note);

  return { valid: true, sampleTokenCount: count, note };
}
