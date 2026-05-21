# ADR-0001: Multi-tenant isolation via Postgres Row-Level Security

- **Status:** Accepted
- **Date:** 2026-05-21 (backfilled — implemented in S2)
- **Deciders:** CarePulse core team
- **Blueprint ref:** Part I §4, Part IX §46 ADR-1

## Context

CarePulse stores PHI for multiple tenants (hospitals, clinics) in a shared Postgres cluster. We need hard isolation between tenants without operating one database per tenant (cost, migration overhead, connection-pool fragmentation). The application layer also runs across multiple services that talk to the same database, so isolation cannot live solely in the ORM.

## Decision

Use **Postgres Row-Level Security (RLS)** with a per-transaction tenant context.

- Every PHI-bearing table has `tenant_id uuid not null` and an RLS policy `tenant_id = current_setting('app.current_tenant_id')::uuid`.
- Each service sets `SET LOCAL app.current_tenant_id = '<uuid>'` at the start of every transaction, derived from the authenticated JWT claim.
- Service DB roles are non-superuser and `BYPASSRLS` is never granted in prod.
- Migrations live in [infra/docker/postgres/migrations/002_rls.sql](../infra/docker/postgres/migrations/002_rls.sql).

## Consequences

**Positive**
- A bug in application code that forgets the WHERE clause cannot leak cross-tenant data — Postgres enforces the boundary.
- Single cluster keeps ops simple; connection pooling stays efficient.
- Audit (ADR-coming) and outbox (ADR-0002) inherit isolation for free.

**Negative**
- Every transaction must `SET LOCAL` — easy to forget in scripts/migrations. Mitigated by a shared DB-client wrapper in each service.
- RLS adds planner overhead on hot queries (~5-10% in benchmarks). Acceptable.
- Superuser-context tools (Debezium, backups) bypass RLS by design — those paths need their own isolation review.

## Alternatives considered

- **Schema-per-tenant:** explodes migration complexity at scale.
- **Database-per-tenant:** ops burden, expensive at >100 tenants.
- **Application-layer filter only:** one missed WHERE clause = breach.
