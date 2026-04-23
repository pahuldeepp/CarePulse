-- 003_audit_log.sql  –  HIPAA-required audit trail for all patient data writes
-- Run after 002_rls.sql.  Idempotent.

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  user_role   TEXT,
  action      TEXT        NOT NULL,   -- e.g. CREATE_PATIENT, UPDATE_ALERT
  resource    TEXT        NOT NULL,   -- e.g. Patient/p-123
  payload     JSONB,
  ip_address  TEXT,
  trace_id    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_idx   ON audit_log (tenant_id,  created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_idx     ON audit_log (user_id,    created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_resource_idx ON audit_log (resource,   created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = current_setting('app.current_tenant_id', true));
