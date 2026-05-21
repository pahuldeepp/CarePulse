-- P0 fix: align RLS variable with ADR-0001.
--
-- 003_alerts.sql created the policy against `app.tenant_id`, but ADR-0001 locks
-- the project-wide convention as `app.current_tenant_id`. patient-service uses
-- the canonical name. Leaving this mismatched means workflow-alerts inserts
-- silently bypass tenant isolation if the caller sets the canonical var, or
-- fail outright if the policy is enforced.

DROP POLICY IF EXISTS alerts_tenant_isolation ON alerts;

CREATE POLICY alerts_tenant_isolation ON alerts
  USING (tenant_id = current_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id'));
