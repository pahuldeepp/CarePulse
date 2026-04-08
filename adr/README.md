# Architecture Decision Records

**Blueprint:** Part IX — §46 ADR Catalogue (15 ADRs in the reference doc).  
ADRs here apply across all `services/` in this monorepo.

## Convention

- `adr/NNNN-title.md` — one ADR per file (e.g. `0001-tenant-rls-strategy.md`)
- Status: Proposed | Accepted | Superseded

## Suggested first ADRs (from blueprint themes)

1. Multi-tenant isolation (Postgres RLS + `SET LOCAL`)
2. Outbox vs dual-write (Kafka publication)
3. Cassandra vs Postgres for telemetry time-series
4. GraphQL gateway vs BFF proliferation
