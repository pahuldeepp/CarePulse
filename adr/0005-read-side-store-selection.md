# ADR-0005: Read-side store selection (CQRS projections)

- **Status:** Proposed
- **Date:** 2026-05-21
- **Blueprint ref:** Part IX §46 ADR-2/7
- **Related:** [0001](0001-tenant-rls-strategy.md), [0002](0002-transactional-outbox.md), [0003](0003-debezium-cdc.md)

## Context

CarePulse runs CQRS-style projections (S5 read-model-builder, S3 alert mirror, S6 search-indexer). Today we use three stores on the read side: Postgres, DynamoDB, OpenSearch. There is no written rule for which to pick, which has already led to one inconsistency (see "Findings" below). We need a default and a small set of justified exceptions so the fourth store doesn't get added on a whim.

## Decision

### Default: **Postgres** for new projections.

Reasons that apply to most read models in this system:
- Tenant isolation via RLS ([ADR-0001](0001-tenant-rls-strategy.md)) reused for free.
- Joins and ad-hoc dashboard queries are first-class.
- One less failure domain; the team already operates it.

### Exception: **DynamoDB** for the alert read/escalation path.

Justified for `alerts` because:
- p99 latency under load matters clinically (NHS NEWS2 15-minute escalation window).
- R7 multi-region needs global tables.
- DynamoDB Streams drives the escalation Lambda — this is an architectural coupling, not just a store choice.

### Exception: **OpenSearch** for text/faceted search.

Already chosen in S6 for patient search. Extend to audit-log search if/when needed.

### Rule: **all projections are Kafka-consumer driven.**

No service writes to two stores in the request hot path. The event log is the source of truth; projections are rebuildable.

## Findings from audit of `workflow-alerts` (2026-05-21)

[services/workflow-alerts/src/alerts/alerts.service.ts:48](../services/workflow-alerts/src/alerts/alerts.service.ts) currently dual-writes Postgres + DynamoDB inside `handleRiskScored` and `acknowledgeAlert`. DynamoDB failures are caught and logged at [line 109](../services/workflow-alerts/src/alerts/alerts.service.ts), so:

- Postgres can succeed while DynamoDB fails silently.
- The escalation Lambda (triggered by DynamoDB Streams) then never fires.
- The Postgres alert row exists, dashboards look healthy, **no nurse is paged**.

This is a clinical-safety hazard, not just tech debt. Tracking as `S9-08` (new) — see [docs/sprints/S9-S10.md](../docs/sprints/S9-S10.md).

## Consequences

**Positive**
- Clear rule prevents store sprawl.
- Forcing Kafka-consumer-driven projections removes the dual-write hazard above by construction.
- Postgres-default keeps cognitive load low for the team.

**Negative**
- Migrating `workflow-alerts` off the dual-write is non-trivial (need a new consumer service or a worker in workflow-alerts that subscribes to a `domain.alert.created` topic). Sequencing matters — see migration plan.

## Migration plan for the alert dual-write

1. Add `domain.alert.created` and `domain.alert.acknowledged` topics emitted from the existing Postgres outbox (Debezium picks them up via [ADR-0003](0003-debezium-cdc.md)).
2. New consumer `alert-dynamo-projector` (or a worker inside `workflow-alerts`) tails these topics and writes DynamoDB. Idempotent by `alert_id`.
3. Remove the in-service `writeToDynamo` calls. Confirm escalation Lambda still fires end-to-end.
4. Add a `domain.alert.created → dynamo lag` SLI to [error-budget-policy.md](../docs/sre/error-budget-policy.md).

## Alternatives considered

- **Postgres everywhere, drop DynamoDB.** Tempting, but the existing Lambda escalation chain would need a Postgres-LISTEN bridge or polling. More risk than value right now; revisit at R7 if multi-region forces the question.
- **DynamoDB everywhere.** Loses joins for dashboards; RLS-equivalent isolation has to be reinvented in IAM/condition-keys per tenant.
- **Materialized views in Postgres for everything.** Fine for low-write projections; alerts have too much write churn and need <50ms read latency under load.
