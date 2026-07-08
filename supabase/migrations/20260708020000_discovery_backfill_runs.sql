-- One-time discovery backfill resume cursor storage.
--
-- `change-detection` remains the recurring crawler. This table is for scoped,
-- manually-triggered historical backfills that need to pause before an Edge
-- Function deadline and resume from a persisted queue on the next invocation.

CREATE TABLE IF NOT EXISTS public.discovery_backfill_runs (
  id                           text PRIMARY KEY,
  source_id                    text NOT NULL,
  doc_type                     text NOT NULL CHECK (doc_type IN (
                                 'budget_pdf', 'bos_minutes', 'bos_summary',
                                 'ordinance', 'municode_api'
                               )),
  status                       text NOT NULL DEFAULT 'in_progress' CHECK (status IN (
                                 'in_progress', 'complete', 'failed'
                               )),
  resume_state                 jsonb NOT NULL,
  pages_fetched                int NOT NULL DEFAULT 0,
  candidate_urls_seen          int NOT NULL DEFAULT 0,
  pending_ingestions_created   int NOT NULL DEFAULT 0,
  active_ingestions_skipped    int NOT NULL DEFAULT 0,
  current_documents_skipped    int NOT NULL DEFAULT 0,
  errors                       jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at                   timestamptz NOT NULL DEFAULT now(),
  last_invoked_at              timestamptz NOT NULL DEFAULT now(),
  completed_at                 timestamptz NULL,
  last_error                   text NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_backfill_runs_source_id_idx
  ON public.discovery_backfill_runs (source_id);

DROP TRIGGER IF EXISTS trg_discovery_backfill_runs_updated_at
  ON public.discovery_backfill_runs;
CREATE TRIGGER trg_discovery_backfill_runs_updated_at
  BEFORE UPDATE ON public.discovery_backfill_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.discovery_backfill_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discovery_backfill_runs FROM anon, authenticated;
