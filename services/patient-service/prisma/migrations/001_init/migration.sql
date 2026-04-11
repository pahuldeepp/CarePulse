-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'CLINICIAN', 'VIEWER');

-- CreateTable: tenants
CREATE TABLE "tenants" (
    "id"         TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "slug"       TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateTable: users
CREATE TABLE "users" (
    "id"         TEXT NOT NULL,
    "tenant_id"  TEXT NOT NULL,
    "email"      TEXT NOT NULL,
    "role"       "Role" NOT NULL DEFAULT 'VIEWER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateTable: patients
CREATE TABLE "patients" (
    "id"            TEXT NOT NULL,
    "tenant_id"     TEXT NOT NULL,
    "mrn"           TEXT NOT NULL,
    "first_name"    TEXT NOT NULL,
    "last_name"     TEXT NOT NULL,
    "date_of_birth" TIMESTAMP(3) NOT NULL,
    "ward"          TEXT,
    "status"        TEXT NOT NULL DEFAULT 'active',
    "deleted_at"    TIMESTAMP(3),
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patients_tenant_id_mrn_key" ON "patients"("tenant_id", "mrn");

-- CreateTable: alerts
CREATE TABLE "alerts" (
    "id"          TEXT NOT NULL,
    "tenant_id"   TEXT NOT NULL,
    "patient_id"  TEXT NOT NULL,
    "dedupe_key"  TEXT NOT NULL,
    "severity"    TEXT NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'open',
    "version"     INTEGER NOT NULL DEFAULT 0,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "alerts_tenant_id_dedupe_key_key" ON "alerts"("tenant_id", "dedupe_key");

-- CreateTable: care_plans
CREATE TABLE "care_plans" (
    "id"          TEXT NOT NULL,
    "tenant_id"   TEXT NOT NULL,
    "patient_id"  TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "notes"       TEXT,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "care_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable: outbox_events
CREATE TABLE "outbox_events" (
    "id"            TEXT NOT NULL,
    "tenant_id"     TEXT NOT NULL,
    "aggregate_id"  TEXT NOT NULL,
    "event_type"    TEXT NOT NULL,
    "payload"       JSONB NOT NULL,
    "processed_at"  TIMESTAMP(3),
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outbox_events_processed_at_created_at_idx"
    ON "outbox_events"("processed_at", "created_at");

-- CreateTable: processed_events
CREATE TABLE "processed_events" (
    "id"           TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable: patient_dashboard_projection (read model)
CREATE TABLE "patient_dashboard_projection" (
    "id"          TEXT NOT NULL,
    "tenant_id"   TEXT NOT NULL,
    "mrn"         TEXT NOT NULL,
    "full_name"   TEXT NOT NULL,
    "ward"        TEXT,
    "status"      TEXT NOT NULL DEFAULT 'active',
    "news2_score" INTEGER,
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "patient_dashboard_projection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "patient_dashboard_projection_tenant_id_idx"
    ON "patient_dashboard_projection"("tenant_id");

-- Foreign Keys
ALTER TABLE "users"
    ADD CONSTRAINT "users_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patients"
    ADD CONSTRAINT "patients_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alerts"
    ADD CONSTRAINT "alerts_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patients"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "outbox_events"
    ADD CONSTRAINT "outbox_events_aggregate_id_fkey"
    FOREIGN KEY ("aggregate_id") REFERENCES "patients"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Row-Level Security (RLS) ──────────────────────────────────────────────────
-- Every tenant-scoped table is locked behind a Postgres policy.
-- The app sets: SET LOCAL app.current_tenant_id = '<id>'
-- at the start of every transaction via Prisma middleware.

ALTER TABLE "patients"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alerts"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "care_plans"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events"     ENABLE ROW LEVEL SECURITY;

-- patients policy
CREATE POLICY "tenant_isolation" ON "patients"
    USING (tenant_id = current_setting('app.current_tenant_id', true));

-- users policy
CREATE POLICY "tenant_isolation" ON "users"
    USING (tenant_id = current_setting('app.current_tenant_id', true));

-- alerts policy
CREATE POLICY "tenant_isolation" ON "alerts"
    USING (tenant_id = current_setting('app.current_tenant_id', true));

-- care_plans policy
CREATE POLICY "tenant_isolation" ON "care_plans"
    USING (tenant_id = current_setting('app.current_tenant_id', true));

-- outbox_events policy
CREATE POLICY "tenant_isolation" ON "outbox_events"
    USING (tenant_id = current_setting('app.current_tenant_id', true));

-- App role (used by Prisma connection — not a superuser)
-- Run once as superuser:
-- CREATE ROLE carepack_app LOGIN PASSWORD 'carepack';
-- GRANT ALL ON ALL TABLES IN SCHEMA public TO carepack_app;
-- GRANT USAGE ON SCHEMA public TO carepack_app;
