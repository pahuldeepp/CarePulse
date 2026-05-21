-- Enable RLS on outbox_events. ADR-0001 says every PHI-bearing table gets RLS;
-- outbox carries patient/alert payloads so it qualifies. Without this, a service
-- using a non-superuser role could read other tenants' outbox events.
--
-- Debezium connects with REPLICATION role which bypasses RLS by design — that's
-- the expected and documented behavior (see ADR-0003).

ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbox_events_tenant_isolation ON "outbox_events";

CREATE POLICY outbox_events_tenant_isolation ON "outbox_events"
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
