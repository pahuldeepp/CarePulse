# ADR-0003: Debezium CDC as the primary outbox relay

- **Status:** Accepted
- **Date:** 2026-05-21 (backfilled — implemented in S5)
- **Blueprint ref:** Part IX §46 ADR-2/§46 ADR-7

## Context

[ADR-0002](0002-transactional-outbox.md) commits us to an outbox table. We need a relay that turns `outbox_events` rows into Kafka messages reliably, with low latency, no polling churn, and no application-layer code in the hot path.

## Decision

Use **Debezium 2.7 via Kafka Connect**, tailing Postgres WAL through the `pgoutput` logical decoding plugin.

- Connector config: [infra/docker/debezium/outbox-connector.json](../infra/docker/debezium/outbox-connector.json)
- Bootstrap script: [register-connector.sh](../infra/docker/debezium/register-connector.sh) — idempotent.
- Topic: `cdc.outbox.events`.
- A `jobs-worker` reaper covers the case where Debezium itself is down — re-publishes stuck rows, then purges processed rows past TTL.

## Consequences

**Positive**
- Sub-second outbox-to-Kafka latency.
- No application polling; WAL is read once and fanned out.
- Connect cluster gives us a managed restart/offset surface.

**Negative**
- Kafka Connect is one more thing to operate; adds ZK/KRaft + Connect to the dev stack.
- Schema evolution of `outbox_events` requires a connector restart with care for offsets.
- Debezium runs as a Postgres superuser-equivalent (replication role) — bypasses RLS by design (see [ADR-0001](0001-tenant-rls-strategy.md)). Tenancy must be enforced in the event payload, not relied on at the WAL layer.

## Alternatives considered

- **Application-side poller:** simpler but adds load and latency floor.
- **Kafka Streams app reading from a `pg_logical` slot directly:** reinvents Debezium.
- **No primary relay, just the reaper:** raises baseline latency to the tick interval (60s).
