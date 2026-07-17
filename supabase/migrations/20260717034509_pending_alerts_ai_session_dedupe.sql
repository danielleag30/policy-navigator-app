-- Deduplicate repeated AI-session deferral alerts.
--
-- The ingest orchestrator can legitimately defer a pending_ingestions row when
-- Supabase.ai.Session is not warm yet. With the 3-minute cron cadence, the old
-- insert-only pending_alerts write path created a fresh row for the same
-- pending_ingestion_id on every deferral. Keep one active alert per
-- pending_ingestion_id/reason pair and track repeats on that row.

ALTER TABLE public.pending_alerts
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS occurrence_count integer NOT NULL DEFAULT 1;

UPDATE public.pending_alerts
SET last_seen_at = triggered_at
WHERE occurrence_count = 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pending_alerts_occurrence_count_positive'
      AND conrelid = 'public.pending_alerts'::regclass
  ) THEN
    ALTER TABLE public.pending_alerts
      ADD CONSTRAINT pending_alerts_occurrence_count_positive
      CHECK (occurrence_count >= 1);
  END IF;
END $$;

WITH ai_session_rows AS (
  SELECT
    id,
    details ->> 'pending_ingestion_id' AS pending_ingestion_id,
    row_number() OVER (
      PARTITION BY details ->> 'pending_ingestion_id'
      ORDER BY triggered_at DESC, created_at DESC, id DESC
    ) AS rn,
    count(*) OVER (
      PARTITION BY details ->> 'pending_ingestion_id'
    ) AS occurrence_count,
    max(triggered_at) OVER (
      PARTITION BY details ->> 'pending_ingestion_id'
    ) AS last_seen_at
  FROM public.pending_alerts
  WHERE alert_type = 'ingestion_failure'
    AND details ->> 'pending_ingestion_id' IS NOT NULL
    AND details ->> 'message' =
      'AI Session unavailable (ai_session_unavailable) — deferred without consuming retry'
),
canonical_ai_session_rows AS (
  SELECT *
  FROM ai_session_rows
  WHERE rn = 1
)
UPDATE public.pending_alerts AS alert
SET
  dedupe_key = 'pending_ingestion:' ||
    canonical.pending_ingestion_id ||
    ':ai_session_defer:ai_session_unavailable',
  details = alert.details || jsonb_build_object('reason', 'ai_session_unavailable'),
  triggered_at = canonical.last_seen_at,
  last_seen_at = canonical.last_seen_at,
  occurrence_count = canonical.occurrence_count
FROM canonical_ai_session_rows AS canonical
WHERE alert.id = canonical.id;

WITH ai_session_rows AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY details ->> 'pending_ingestion_id'
      ORDER BY triggered_at DESC, created_at DESC, id DESC
    ) AS rn
  FROM public.pending_alerts
  WHERE alert_type = 'ingestion_failure'
    AND details ->> 'pending_ingestion_id' IS NOT NULL
    AND details ->> 'message' =
      'AI Session unavailable (ai_session_unavailable) — deferred without consuming retry'
)
UPDATE public.pending_alerts AS alert
SET
  acknowledged = true,
  acknowledged_at = COALESCE(alert.acknowledged_at, now())
FROM ai_session_rows AS duplicate
WHERE alert.id = duplicate.id
  AND duplicate.rn > 1
  AND alert.acknowledged = false;

CREATE UNIQUE INDEX IF NOT EXISTS pending_alerts_dedupe_key_idx
  ON public.pending_alerts (dedupe_key);

CREATE OR REPLACE FUNCTION public.upsert_pending_alert(
  p_alert_type text,
  p_details jsonb,
  p_dedupe_key text DEFAULT NULL,
  p_triggered_at timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  alert_id uuid;
BEGIN
  INSERT INTO public.pending_alerts (
    alert_type,
    details,
    dedupe_key,
    triggered_at,
    last_seen_at,
    occurrence_count
  )
  VALUES (
    p_alert_type,
    p_details,
    p_dedupe_key,
    p_triggered_at,
    p_triggered_at,
    1
  )
  ON CONFLICT (dedupe_key) DO UPDATE
  SET
    details = EXCLUDED.details,
    triggered_at = EXCLUDED.triggered_at,
    last_seen_at = EXCLUDED.last_seen_at,
    occurrence_count = public.pending_alerts.occurrence_count + 1,
    acknowledged = false,
    acknowledged_at = NULL
  RETURNING id INTO alert_id;

  RETURN alert_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_pending_alert(text, jsonb, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_pending_alert(text, jsonb, text, timestamptz)
  TO service_role;
