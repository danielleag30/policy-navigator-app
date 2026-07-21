-- Persisted resumable cursor + progress for the deep-historical OCR
-- pre-ingestion job (supabase/functions/encode-reprint-preingest). One row
-- per EnCode zoning reprint. Rows are upserted lazily by the Edge Function
-- itself (sourced at runtime from query-pipeline/_deep-historical.ts's
-- ENCODE_ZONING_REPRINTS -- the single source of truth for the 18-reprint
-- list) rather than seeded by this migration, so the list is never
-- duplicated in SQL and can't drift if that table ever changes.
--
-- Same atomic-claim lease shape as discovery_crawl_state.claim_expires_at /
-- documents.resume_claim_expires_at (proven by findResumableDocument() in
-- municode.ts and claimSource() in change-detection/_crawl_state.ts): a
-- conditional UPDATE ... WHERE claim_expires_at IS NULL OR claim_expires_at
-- < now() ... RETURNING claims one reprint's row for the duration this
-- invocation is actively OCR'ing it, so two overlapping cron ticks can never
-- double-process the same reprint's page cursor.
--
-- next_page is the resume cursor: 1-indexed, "next page to OCR". A crash or
-- soft-deadline exit mid-document loses at most the in-flight page-chunk
-- (re-OCR'd on the next claim, cheap and idempotent via encode_reprint_pages'
-- upsert) rather than any already-completed pages.

CREATE TABLE IF NOT EXISTS public.encode_reprint_preingest_state (
  doc_library_id   text PRIMARY KEY,
  reprint_label    text NOT NULL,
  reprint_year     int  NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete')),
  total_pages      int,
  next_page        int NOT NULL DEFAULT 1,
  pages_completed  int NOT NULL DEFAULT 0,
  claim_expires_at timestamptz,
  last_invoked_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS encode_reprint_preingest_state_last_invoked_at_idx
  ON public.encode_reprint_preingest_state (last_invoked_at)
  WHERE status <> 'complete';

DROP TRIGGER IF EXISTS trg_encode_reprint_preingest_state_updated_at
  ON public.encode_reprint_preingest_state;
CREATE TRIGGER trg_encode_reprint_preingest_state_updated_at
  BEFORE UPDATE ON public.encode_reprint_preingest_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.encode_reprint_preingest_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.encode_reprint_preingest_state FROM anon, authenticated;

-- Extracted OCR'd page text for pre-ingested EnCode zoning reprints. One row
-- per (doc_library_id, page_number) that produced non-empty OCR text --
-- sparse by design; a page OCR'd to nothing (e.g. genuinely blank) advances
-- the cursor above without a row here.
--
-- The query-side fast path (query-pipeline/_deep-historical.ts) reads this
-- table directly instead of performing a live OCR fetch, once a reprint's
-- preingest_state row reaches status = 'complete'. Rows are shaped to map
-- 1:1 onto the Docling wrapper's FlatBlock contract (page_number ==
-- FlatBlock.page_no, one block per page) so the exact same chunkBlocks() /
-- page-citation pipeline the live-fetch path already uses works unchanged
-- regardless of which source (DB or live OCR) supplied the text.

CREATE TABLE IF NOT EXISTS public.encode_reprint_pages (
  id               uuid PRIMARY KEY,
  doc_library_id   text NOT NULL,
  page_number      int  NOT NULL,
  text             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_library_id, page_number)
);

CREATE INDEX IF NOT EXISTS encode_reprint_pages_doc_library_id_page_idx
  ON public.encode_reprint_pages (doc_library_id, page_number);

DROP TRIGGER IF EXISTS trg_encode_reprint_pages_updated_at
  ON public.encode_reprint_pages;
CREATE TRIGGER trg_encode_reprint_pages_updated_at
  BEFORE UPDATE ON public.encode_reprint_pages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.encode_reprint_pages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.encode_reprint_pages FROM anon, authenticated;
