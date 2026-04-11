# CarePulse

> **Real-time patient deterioration detection SaaS for hospital wards.**
> Multi-tenant · Polyglot · 13 microservices · Reference architecture by Pahuldeep Singh.

[![CI — Go](https://github.com/pahuldeepp/CarePulse/actions/workflows/ci-go.yml/badge.svg)](https://github.com/pahuldeepp/CarePulse/actions/workflows/ci-go.yml)
[![CI — Node](https://github.com/pahuldeepp/CarePulse/actions/workflows/ci-node.yml/badge.svg)](https://github.com/pahuldeepp/CarePulse/actions/workflows/ci-node.yml)
[![CI — Python](https://github.com/pahuldeepp/CarePulse/actions/workflows/ci-python.yml/badge.svg)](https://github.com/pahuldeepp/CarePulse/actions/workflows/ci-python.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=pahuldeepp_CarePulse&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=pahuldeepp_CarePulse)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=pahuldeepp_CarePulse&metric=coverage)](https://sonarcloud.io/summary/new_code?id=pahuldeepp_CarePulse)

---

## What it solves

Nurses monitoring a busy ward miss subtle vital-sign trends until a patient crashes. CarePulse ingests device telemetry every second, scores each reading with **NEWS2 + qSOFA** (clinical deterioration algorithms), and surfaces a colour-coded alert in the clinician's EHR before the patient deteriorates — with no extra app to open.

---

## Quick start (local dev)

**Prerequisites:** Docker Desktop, Go 1.22+, Node 20+, Python 3.12+

```bash
# 1. Clone
git clone https://github.com/pahuldeepp/CarePulse.git
cd CarePulse

# 2. Start all infrastructure (Postgres, Kafka, Redis, RabbitMQ, PgBouncer)
docker compose -f infra/docker/docker-compose.yml up -d

# 3. Run a service (example: telemetry-ingest on :8080)
cd services/telemetry-ingest && go run .

# 4. Run risk-engine (FastAPI on :8001)
cd services/risk-engine && pip install -e . && python main.py

# 5. Run gateway-graphql (Apollo on :4000)
cd services/gateway-graphql && npm install && node src/index.js
```

### Healthchecks

| Service | URL |
|---------|-----|
| telemetry-ingest | http://localhost:8080/healthz |
| risk-engine | http://localhost:8001/healthz |
| fhir-gateway | http://localhost:8002/healthz |
| gateway-graphql | http://localhost:4000/healthz |
| jobs-worker | http://localhost:4001/healthz |
| notification-service | http://localhost:4002/healthz |
| search-indexer | http://localhost:8084/healthz |

---

## Port map

| Port | Service | Runtime |
|------|---------|---------|
| 5432 | Postgres 16 | Docker |
| 5433 | PgBouncer | Docker |
| 9092 | Kafka (KRaft) | Docker |
| 6379 | Redis 7 | Docker |
| 5672 | RabbitMQ | Docker |
| 15672 | RabbitMQ UI | Docker |
| 8080 | telemetry-ingest | Go |
| 8081 | projection-builder | Go |
| 8082 | asset-registry | Go |
| 8083 | saga-orchestrator | Go |
| 8001 | risk-engine | Python |
| 8002 | fhir-gateway | Python |
| 8084 | search-indexer | Python |
| 4000 | gateway-graphql | Node |
| 4001 | jobs-worker | Node |
| 4002 | notification-service | Node |
| 3000 | patient-service | NestJS |
| 3001 | workflow-alerts | NestJS |
| 3002 | billing-service | NestJS |

---

## Environment variables

Copy `.env.example` to `.env` (gitignored) before running services locally.

| Variable | Default | Used by |
|----------|---------|---------|
| `DATABASE_URL` | `postgres://carepack:carepack@localhost:5433/carepack` | Go + Node services |
| `KAFKA_BROKERS` | `localhost:9092` | All services |
| `KAFKA_REPLICATION_FACTOR` | `3` (prod) / `1` (local) | patient-service |
| `JWT_SECRET` | — | gateway-graphql |
| `RABBITMQ_URL` | `amqp://carepack:carepack@localhost:5672/carepack` | Node services |
| `REDIS_URL` | `redis://localhost:6379` | gateway-graphql |
| `OTEL_SERVICE_NAME` | service name | all services |
| `PORT` | per-service default | all services |

---

## Monorepo layout

```
CarePulse/
├── services/           # 13 microservices (one folder each)
├── packages/           # shared libraries
│   ├── otel-go/        # OTel SDK bootstrap for Go services
│   ├── otel-node/      # OTel SDK bootstrap for Node services
│   └── otel-python/    # OTel SDK bootstrap for Python services
├── infra/
│   └── docker/         # docker-compose.yml (local dev stack)
├── contracts/          # OpenAPI + gRPC proto stubs
├── apps/web/           # React/TypeScript dashboard (S8)
├── adr/                # Architecture Decision Records
└── .github/workflows/  # CI — Go, Node, Python gates
```

---

## Services

| Service | Runtime | Port | Sprint | Status |
|---------|---------|------|--------|--------|
| telemetry-ingest | Go | 8080 | S1 | ✅ |
| projection-builder | Go | 8081 | S2 | ✅ Kafka consumer + dashboard upsert |
| asset-registry | Go | 8082 | S1 | ✅ |
| saga-orchestrator | Go | 8083 | S1 | ✅ |
| risk-engine | Python/FastAPI | 8001 | S3 | 🔜 NEWS2 scoring |
| fhir-gateway | Python/FastAPI | 8002 | S1 | ✅ |
| search-indexer | Python asyncio | 8084 | S1 | ✅ |
| gateway-graphql | Node/Express/Apollo | 4000 | S2 | ✅ JWT auth + Patient GraphQL |
| jobs-worker | Node/RabbitMQ | 4001 | S1 | ✅ |
| notification-service | Node/RabbitMQ | 4002 | S1 | ✅ |
| patient-service | NestJS/Prisma | 3000 | S2 | ✅ Outbox pattern + RLS |
| workflow-alerts | NestJS | 3001 | S3 | 🔜 Alert pipeline |
| billing-service | NestJS/Stripe | 3002 | S1 | ✅ |

### S2 highlights

- **Multi-tenant Postgres** — Row-Level Security on all tables; `app.current_tenant_id` set per transaction
- **Transactional outbox** — patient + Kafka event written atomically; relay ensures no lost events
- **Kafka topics** — `patient.created`, `patient.updated`, `alert.triggered` provisioned on boot
- **projection-builder** — Go consumer upserts `patient_dashboard_projection` read model
- **GraphQL gateway** — HS256 JWT auth, RBAC role guard, `patient` / `patients` queries with tenant isolation
- **Observability** — zerolog/Winston/structlog with OTel trace_id + span_id correlation

---

## Tooling

```bash
npm run lint        # ESLint on root tooling + Node services
npm run lint:py     # Ruff lint on Python services
npm run lint:go     # golangci-lint on telemetry-ingest
npm run claude      # Claude Code agent
npm run codex       # Codex CLI
go work sync        # sync Go workspace
pre-commit run -a   # run all pre-commit hooks manually
```

---

## Sprint plan

14 sprints · 7 releases · 28 weeks. See `CarePulse_Sprint_Plan_v1.pdf`.

| Release | Sprints | Milestone |
|---------|---------|-----------|
| R1 | S1–S2 | End-to-end OTel trace · replay from offset 0 |
| R2 | S3–S4 | Risk scores flowing · alert pipeline live |
| R3 | S5–S6 | CDC topics stable · search SLO dashboard |
| R4 | S7–S8 | 10K concurrent sustained · chaos recovery proven |
| R5 | S9–S10 | Monthly incident drill · error budget policy active |
| R6 | S11–S12 | HIPAA checklist complete · BAAs in place |
| R7 | S13–S14 | Multi-region failover tested · SaaS deployable |
