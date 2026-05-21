# Architecture Decision Records

**Blueprint:** Part IX — §46 ADR Catalogue (15 ADRs in the reference doc).
ADRs here apply across all `services/` in this monorepo.

## Convention

- `adr/NNNN-title.md` — one ADR per file (e.g. `0001-tenant-rls-strategy.md`)
- Status: Proposed | Accepted | Superseded

## Index

- [0001 — Tenant RLS strategy](0001-tenant-rls-strategy.md) — Accepted
- [0002 — Transactional outbox](0002-transactional-outbox.md) — Accepted
- [0003 — Debezium CDC as outbox relay](0003-debezium-cdc.md) — Accepted
- [0005 — Read-side store selection](0005-read-side-store-selection.md) — Proposed

## Suggested next ADRs (from blueprint themes)

- 0004 — Paging tool (PagerDuty vs Opsgenie) — needed by S10
- 0006 — Cassandra vs Postgres for telemetry time-series
- 0007 — GraphQL gateway vs BFF proliferation
