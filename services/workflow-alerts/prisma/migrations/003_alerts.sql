-- Sprint 3: alerts table
-- Postgres is source of truth for alert history + audit trail.
-- DynamoDB alerts table (carepulse-alerts) is written separately by AlertsService
-- to trigger DynamoDB Streams → stream_handler Lambda → 15-min escalation flow.

CREATE TABLE IF NOT EXISTS alerts (
  alert_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT        NOT NULL,
  device_id       TEXT        NOT NULL,
  severity        TEXT        NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  news2           INT         NOT NULL,
  qsofa           INT         NOT NULL,
  triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT
);

-- RLS: tenants can only read their own alerts
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY alerts_tenant_isolation ON alerts
  USING (tenant_id = current_setting('app.tenant_id'));

CREATE INDEX alerts_tenant_triggered ON alerts (tenant_id, triggered_at DESC);
