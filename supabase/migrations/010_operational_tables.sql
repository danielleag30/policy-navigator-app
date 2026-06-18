-- Migration 010: operational tables
-- pending_ingestions, rate_limit_buckets, request_logs, pending_alerts.
-- UUID v7: always Deno-generated. No server-side default on id.
-- NOTE: request_logs and rate_limit_buckets have no updated_at column.
-- request_logs is append-only; do not apply set_updated_at() trigger.

-- ─────────────────────────────────────────────────────────────
-- Table 1: pending_ingestions
-- ─────────────────────────────────────────────────────────────
CREATE TABLE pending_ingestions (
  id              uuid PRIMARY KEY,
  url             text NOT NULL,
  doc_type        text NOT NULL CHECK (doc_type IN (
                    'budget_pdf', 'bos_minutes', 'bos_summary',
                    'ordinance', 'municode_api'
                  )),
  detected_at     timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending', 'processing', 'failed', 'skipped'
                  )),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NULL,
  last_error      text NULL,
  last_attempted  timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON pending_ingestions (status);
CREATE INDEX ON pending_ingestions (doc_type);
CREATE INDEX ON pending_ingestions (detected_at);
CREATE INDEX ON pending_ingestions (next_attempt_at)
  WHERE status = 'pending';

ALTER TABLE pending_ingestions ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────
-- Table 2: rate_limit_buckets
-- ─────────────────────────────────────────────────────────────
CREATE TABLE rate_limit_buckets (
  id              uuid PRIMARY KEY,
  ip_address      text NOT NULL,
  window_start    timestamptz NOT NULL,
  request_count   int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rate_limit_buckets_ip_address_window_start_key
    UNIQUE (ip_address, window_start)
);

CREATE INDEX ON rate_limit_buckets (ip_address, window_start);
CREATE INDEX ON rate_limit_buckets (window_start);

ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────
-- Table 3: request_logs  (append-only — no updated_at)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE request_logs (
  id                uuid PRIMARY KEY,
  ip_address        text NOT NULL,
  query_text        text NOT NULL,
  response_ms       int NOT NULL,
  chunk_count       int NOT NULL,
  llm_calls         int NOT NULL,
  temporal_flag     boolean NOT NULL DEFAULT false,
  verifier_flag     boolean NOT NULL DEFAULT false,
  refusal           boolean NOT NULL DEFAULT false,
  incomplete_search boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON request_logs (created_at);
CREATE INDEX ON request_logs (ip_address);
CREATE INDEX ON request_logs (refusal)
  WHERE refusal = true;
CREATE INDEX ON request_logs (incomplete_search)
  WHERE incomplete_search = true;

ALTER TABLE request_logs ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────
-- Table 4: pending_alerts
-- ─────────────────────────────────────────────────────────────
CREATE TABLE pending_alerts (
  id              uuid PRIMARY KEY,
  alert_type      text NOT NULL CHECK (alert_type IN (
                    'rate_abuse',
                    'ingestion_failure',
                    'high_refusal_rate'
                  )),
  details         jsonb NOT NULL,
  triggered_at    timestamptz NOT NULL DEFAULT now(),
  acknowledged    boolean NOT NULL DEFAULT false,
  acknowledged_at timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON pending_alerts (alert_type);
CREATE INDEX ON pending_alerts (acknowledged)
  WHERE acknowledged = false;
CREATE INDEX ON pending_alerts (triggered_at);

ALTER TABLE pending_alerts ENABLE ROW LEVEL SECURITY;
