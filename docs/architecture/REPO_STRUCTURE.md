# Repository structure ↔ CarePulse Blueprint v1

This tree mirrors **Part I §4 Reference Architecture** and **Part II §5 Full Service Map** in `CarePulse_Healthcare_Blueprint_v1.pdf`.

## Layer mapping

```
Presentation (React/TS, RN)     → apps/web (web first; mobile noted in README)
API (GraphQL, ingress)          → services/gateway-graphql
Polyglot services               → services/<name>
Messaging (Kafka, RabbitMQ)     → infra/ + per-service consumers (TBD)
Data stores                     → infra/ (Postgres, Redis, etc. — TBD)
```

## Service directories (13 + gateway)

| Directory | Framework (blueprint) | Role |
|-----------|------------------------|------|
| `services/gateway-graphql` | Express + Apollo | Auth, GraphQL, aggregation |
| `services/telemetry-ingest` | Go | Device ingest, validation, outbox |
| `services/projection-builder` | Go | Kafka → CQRS projections |
| `services/asset-registry` | Go + gRPC | Devices/wards/sites provisioning |
| `services/read-model-builder` | Go | Materialized views, rebuilds |
| `services/saga-orchestrator` | Go | Provisioning saga, compensation |
| `services/patient-service` | NestJS + Prisma | Patients, care plans, domain CRUD |
| `services/workflow-alerts` | NestJS + Prisma | Alerts, escalation, RabbitMQ |
| `services/billing-service` | NestJS + Prisma | Stripe, metering, subscriptions |
| `services/risk-engine` | FastAPI + sklearn | Risk scoring, NEWS2, qSOFA |
| `services/fhir-gateway` | FastAPI | HL7 FHIR R4, EHR interop |
| `services/search-indexer` | Python asyncio | OpenSearch indexing |
| `services/jobs-worker` | Express + amqplib | Async jobs, DLQ, idempotency |
| `services/notification-service` | Express | Email/SMS/push |

The blueprint groups **jobs** and **notifications** as separate bounded contexts; both are first-class folders here.

## Other paths

- **`contracts/`** — Protobuf, OpenAPI, shared JSON schemas (Part V).
- **`packages/`** — Shared TS/JS libraries when introduced.
- **`adr/`** — Architecture Decision Records (blueprint §46).
- **`infra/`** — Docker, Helm/K8s, Terraform, CI templates (Part VII §39).

## Next implementation steps

1. Add `docker-compose` (or k3d) under `infra/docker` for Postgres + Kafka + Redis MVP.
2. Scaffold each service with its native toolchain (`go mod init`, `nest new`, `fastapi`, etc.).
3. Land **ADR-0001** (tenant + RLS strategy) in `adr/` before PHI-bearing schema work.
