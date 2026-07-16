-- Resumable, checkpointed state for the RECURRING change-detection crawl.
--
-- Deliberately a NEW table, not a reuse of discovery_backfill_runs
-- (20260708020000): that table's status='complete' means "done forever",
-- which is the wrong semantic for a process that must start a fresh cycle
-- every time it drains its queue, and its doc_type CHECK constraint was
-- scoped to one-time historical backfills (never grew encode_zoning). This
-- table's 'idle' status instead means "ready to start a new cycle" — the
-- crawler transitions in_progress -> idle -> in_progress every cycle,
-- indefinitely, rather than ever reaching a terminal state.
--
-- One row per checkable source: the 5 discovery sources (bos_summary,
-- bos_minutes, budget_committee_meeting, budget_pdf_advertised,
-- budget_pdf_adopted) plus municode_api and encode_zoning, whose own checks
-- are cheap single-URL fetches (no crawl queue) but still get a row here so
-- they share the same overlap-protection lease as the discovery sources —
-- see claim_expires_at below.
--
-- All 7 rows are seeded by this migration (not created lazily at runtime) so
-- the application-side claim path is a single atomic UPDATE against a row
-- that is guaranteed to already exist, with no insert-race to handle.
--
-- resume_state shape (jsonb), discovery sources only:
--   {
--     "version": 1,
--     "phase": "crawl" | "scan",
--     "crawl_queue": [{ "url": text, "depth": int }, ...],
--     "visited_urls": [url, ...],
--     "seen_candidate_urls": [url, ...],
--     "scan_queue": [url, ...]
--   }
-- municode_api and encode_zoning rows leave resume_state at its default
-- ('{}'::jsonb) — they have no crawl queue, only the lease + last_checked_at.
--
-- Overlap protection (cascading-effects review guardrail #2): the same
-- atomic-claim shape as documents.resume_claim_expires_at (20260702000000,
-- proven by findResumableDocument() in municode.ts) — a conditional
-- UPDATE ... WHERE claim_expires_at IS NULL OR claim_expires_at < now() ...
-- RETURNING claims a source's row for the duration this invocation is
-- actively working it. A concurrent invocation whose UPDATE affects zero
-- rows skips that source this tick rather than risking two invocations
-- draining/mutating the same checkpoint at once. private.cron_invoke_edge_function
-- (20260706010000) only holds its advisory lock for the enqueue transaction,
-- not the runtime duration, so this per-source lease is what actually
-- guards a tightened cadence from ever double-processing one source's
-- checkpoint.
--
-- last_checked_at is used by encode_zoning's explicit minimum-interval guard
-- (guardrail #3) so that source's check frequency stays governed by its own
-- setting regardless of how often the other 5 sources' cadence tightens.

CREATE TABLE IF NOT EXISTS public.discovery_crawl_state (
  source_id                   text PRIMARY KEY,
  doc_type                    text NOT NULL CHECK (doc_type IN (
                                 'budget_pdf', 'bos_minutes', 'bos_summary',
                                 'ordinance', 'municode_api', 'encode_zoning'
                               )),
  status                       text NOT NULL DEFAULT 'idle' CHECK (status IN (
                                 'idle', 'in_progress'
                               )),
  resume_state                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  claim_expires_at             timestamptz,
  cycle_started_at             timestamptz,
  last_cycle_completed_at      timestamptz,
  last_checked_at              timestamptz,
  cycles_completed             bigint NOT NULL DEFAULT 0,
  pages_fetched                int NOT NULL DEFAULT 0,
  candidate_urls_seen          int NOT NULL DEFAULT 0,
  pending_ingestions_created   int NOT NULL DEFAULT 0,
  active_ingestions_skipped    int NOT NULL DEFAULT 0,
  last_checked_updates         int NOT NULL DEFAULT 0,
  errors                       jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_invoked_at              timestamptz NOT NULL DEFAULT now(),
  last_error                   text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_crawl_state_last_invoked_at_idx
  ON public.discovery_crawl_state (last_invoked_at);

DROP TRIGGER IF EXISTS trg_discovery_crawl_state_updated_at
  ON public.discovery_crawl_state;
CREATE TRIGGER trg_discovery_crawl_state_updated_at
  BEFORE UPDATE ON public.discovery_crawl_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.discovery_crawl_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discovery_crawl_state FROM anon, authenticated;

INSERT INTO public.discovery_crawl_state (source_id, doc_type)
VALUES
  ('bos_summary',               'bos_summary'),
  ('bos_minutes',                'bos_minutes'),
  ('budget_committee_meeting',   'bos_minutes'),
  ('budget_pdf_advertised',      'budget_pdf'),
  ('budget_pdf_adopted',         'budget_pdf'),
  ('municode_api',               'municode_api'),
  ('encode_zoning',              'encode_zoning')
ON CONFLICT (source_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Guardrail #6: atomic pending_ingestions creation.
--
-- createPendingIngestion() previously did a SELECT (hasActivePendingIngestion)
-- followed by a separate INSERT — a TOCTOU window where two overlapping
-- invocations (or change-detection racing budget-committee-backfill on a
-- shared URL) could both pass the check and both insert. This partial unique
-- index turns the insert itself into the atomic conditional-write guard,
-- the same "let a constraint make the write atomic" shape already proven by
-- ordinance_provisions_one_current_per_node_idx (002_ordinance_provisions.sql)
-- for municode.ts's supersession logic. Application code now attempts the
-- insert directly and treats a unique-violation (23505) as "already active"
-- instead of pre-checking — see _shared/pending-ingestion.ts.
-- ─────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS pending_ingestions_active_url_doc_type_idx
  ON public.pending_ingestions (url, doc_type)
  WHERE status IN ('pending', 'processing');

-- ─────────────────────────────────────────────────────────────────────────
-- Guardrail #4: alert dedupe support.
--
-- writeStalenessAlerts() and change-detection's error-alerting paths had no
-- dedupe: every invocation that still sees the same stale document or the
-- same discovery/source error writes a fresh pending_alerts row. A tighter
-- cadence directly multiplies that noise. _shared/alerts.ts now looks up the
-- most recent alert sharing the same (reason, alert_key) pair before writing
-- a new one and skips the write if one landed within the cooldown window;
-- this expression index makes that lookup a fast index scan instead of a
-- details-jsonb table scan.
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS pending_alerts_reason_key_triggered_at_idx
  ON public.pending_alerts (
    (details ->> 'reason'),
    (details ->> 'alert_key'),
    triggered_at DESC
  );
