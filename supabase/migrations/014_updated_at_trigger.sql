-- Migration 014: updated_at auto-update trigger
-- Applies a BEFORE UPDATE trigger to all tables that carry an updated_at column.
-- Excluded (no updated_at column): rate_limit_buckets, request_logs, pending_alerts.

-- ─────────────────────────────────────────────────────────────
-- Trigger function
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- Apply trigger to each table that has updated_at
-- ─────────────────────────────────────────────────────────────
CREATE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_ordinance_provisions_updated_at
  BEFORE UPDATE ON public.ordinance_provisions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_vote_tallies_updated_at
  BEFORE UPDATE ON public.vote_tallies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_amendment_events_updated_at
  BEFORE UPDATE ON public.amendment_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_pending_code_changes_updated_at
  BEFORE UPDATE ON public.pending_code_changes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_code_reconciliation_logs_updated_at
  BEFORE UPDATE ON public.code_reconciliation_logs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_policy_decisions_updated_at
  BEFORE UPDATE ON public.policy_decisions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_budget_indicators_updated_at
  BEFORE UPDATE ON public.budget_indicators
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_narrative_chunks_updated_at
  BEFORE UPDATE ON public.narrative_chunks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_pending_ingestions_updated_at
  BEFORE UPDATE ON public.pending_ingestions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
