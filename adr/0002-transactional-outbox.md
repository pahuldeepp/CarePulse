# ADR-0002: Transactional outbox for Postgres → Kafka

- **Status:** Accepted
- **Date:** 2026-05-21 (backfilled — implemented in S2, hardened in S5)
- **Blueprint ref:** Part IX §46 ADR-2

## Context

Services like `patient-service` and `telemetry-ingest` must atomically (a) persist a domain change to Postgres and (b) publish a Kafka event so downstream consumers (projection-builder, risk-engine, search-indexer) can react. A naïve dual write (DB commit + Kafka publish) can leave the system inconsistent if the process dies between the two steps.

## Decision

Adopt the **transactional outbox pattern**.

- Every write that produces a domain event inserts into `outbox_events` in the same transaction as the business row.
- An async relay reads from `outbox_events` and publishes to Kafka.
- Primary relay: **Debezium / Kafka Connect** tailing the WAL (see [ADR-0003](0003-debezium-cdc.md)).
- Fallback relay: `jobs-worker` reaper (60s tick) — purges processed rows past TTL and re-publishes stuck pending rows when Debezium is down.

## Consequences

**Positive**
- Atomicity guaranteed by Postgres; no dual-write inconsistency window.
- Consumers see exactly-once *publication* (dedup is consumer-side responsibility — e.g. risk-engine uses Redis dedup).
- Reaper gives us a survivable path when Debezium is down without rewriting publisher code.

**Negative**
- Outbox table grows fast; reaper TTL purge is critical.
- Two publication paths (Debezium primary, reaper fallback) means consumers must be idempotent.

## Alternatives considered

- **Direct Kafka publish + DB:** dual-write hazard.
- **Listen/notify:** doesn't survive consumer downtime; not durable.
- **Change-data-capture only, no outbox table:** loses the explicit event envelope; harder to evolve schemas independently of physical tables.
