-- 002_rls.sql  –  Row-Level Security: tenant isolation for every projection table
-- Run after 001_init.sql.  Idempotent: uses IF NOT EXISTS / OR REPLACE guards.

-- ── patient_dashboard_projection ─────────────────────────────────────────────
ALTER TABLE patient_dashboard_projection ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON patient_dashboard_projection;
CREATE POLICY tenant_isolation ON patient_dashboard_projection
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- ── device_registrations ─────────────────────────────────────────────────────
ALTER TABLE device_registrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON device_registrations;
CREATE POLICY tenant_isolation ON device_registrations
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- ── alerts ───────────────────────────────────────────────────────────────────
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON alerts;
CREATE POLICY tenant_isolation ON alerts
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- ── outbox_events ─────────────────────────────────────────────────────────────
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON outbox_events;
CREATE POLICY tenant_isolation ON outbox_events
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- ── ward_occupancy_projection ────────────────────────────────────────────────
ALTER TABLE ward_occupancy_projection ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ward_occupancy_projection;
CREATE POLICY tenant_isolation ON ward_occupancy_projection
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- ── alerts_by_priority ───────────────────────────────────────────────────────
ALTER TABLE alerts_by_priority ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON alerts_by_priority;
CREATE POLICY tenant_isolation ON alerts_by_priority
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- ── billing tables (new in S7) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  tenant_id         TEXT        PRIMARY KEY,
  stripe_customer_id TEXT       NOT NULL,
  stripe_sub_id     TEXT        NOT NULL,
  plan              TEXT        NOT NULL DEFAULT 'standard',
  status            TEXT        NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_usage (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT        NOT NULL,
  metric      TEXT        NOT NULL,
  quantity    NUMERIC     NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_usage_tenant_metric_idx
  ON billing_usage (tenant_id, metric, recorded_at);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT        NOT NULL,
  stripe_invoice_id TEXT,
  amount_cents      BIGINT      NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'draft',
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE billing_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing_usage;
CREATE POLICY tenant_isolation ON billing_usage
  USING (tenant_id = current_setting('app.current_tenant_id', true));

ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing_invoices;
CREATE POLICY tenant_isolation ON billing_invoices
  USING (tenant_id = current_setting('app.current_tenant_id', true));
