# Monorepo structure ↔ CarePulse Blueprint v1

**Single GitHub repository** with **multiple microservices** as separate directories. Each folder under `services/` is a bounded context you can build, containerize, and deploy independently (own `Dockerfile`, CI job), while sharing one repo and `contracts/`.

This mirrors **Part I §4 Reference Architecture** and **Part II §5 Full Service Map** in `CarePulse_Healthcare_Blueprint_v1.pdf`.

## Layer mapping

```
Presentation (React/TS, RN)     → apps/web
API (GraphQL, ingress)          → services/gateway-graphql
Polyglot microservices          → services/<name>
Messaging (Kafka, RabbitMQ)     → infra/ + consumers inside each service
Data stores                     → infra/ (compose / K8s / Terraform)
```

## `services/` — microservice directories

| Directory | Framework (blueprint) | Role |
|-----------|------------------------|------|
| `gateway-graphql` | Express + Apollo | Auth, GraphQL, aggregation |
| `telemetry-ingest` | Go | Device ingest, validation, outbox |
| `projection-builder` | Go | Kafka → CQRS projections |
| `asset-registry` | Go + gRPC | Devices/wards/sites provisioning |
| `read-model-builder` | Go | Materialized views, rebuilds |
| `saga-orchestrator` | Go | Provisioning saga, compensation |
| `patient-service` | NestJS + Prisma | Patients, care plans, domain CRUD |
| `workflow-alerts` | NestJS + Prisma | Alerts, escalation, RabbitMQ |
| `billing-service` | NestJS + Prisma | Stripe, metering, subscriptions |
| `risk-engine` | FastAPI + sklearn | Risk scoring, NEWS2, qSOFA |
| `fhir-gateway` | FastAPI | HL7 FHIR R4, EHR interop |
| `search-indexer` | Python asyncio | OpenSearch indexing |
| `jobs-worker` | Express + amqplib | Async jobs, DLQ, idempotency |
| `notification-service` | Express | Email/SMS/push |

## Other paths

- **`contracts/`** — Protobuf, OpenAPI, FHIR shared by services.
- **`packages/`** — Shared TS/JS libraries (generated clients, types).
- **`adr/`** — Architecture Decision Records (blueprint §46).
- **`infra/`** — Docker Compose, Helm/K8s, Terraform, reusable CI.

## CI/CD in a monorepo

- Prefer **path-filtered** workflows (only rebuild images for changed `services/<name>`).
- Publish images e.g. `ghcr.io/<org>/carepack-patient-service:<tag>` from the same repo.

## Next steps

1. Add `infra/docker/docker-compose.yml` for Postgres (+ optional Redis/Kafka).
2. Scaffold the first service under `services/` with its own toolchain.
3. Land **ADR-0001** (tenant + RLS) in `adr/` before PHI-bearing schema work.
