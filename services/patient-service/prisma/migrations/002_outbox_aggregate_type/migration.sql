-- S9-08: generalise outbox_events so non-patient aggregates can write to it.
--
-- Original 001_init wrongly constrained outbox_events.aggregate_id with a FK to
-- patients(id). That blocks workflow-alerts (and any future producer) from using
-- the shared outbox table. The FK was wrong: outbox events are per-aggregate-type,
-- not patient-specific.
--
-- This migration:
--   1. Drops the patients(id) FK so any aggregate_id is valid.
--   2. Adds aggregate_type so consumers (and Debezium routing later) can filter
--      by event family without parsing the payload.

ALTER TABLE "outbox_events"
    DROP CONSTRAINT IF EXISTS "outbox_events_aggregate_id_fkey";

ALTER TABLE "outbox_events"
    ADD COLUMN IF NOT EXISTS "aggregate_type" TEXT NOT NULL DEFAULT 'Patient';

CREATE INDEX IF NOT EXISTS "outbox_events_aggregate_type_idx"
    ON "outbox_events" ("aggregate_type");
