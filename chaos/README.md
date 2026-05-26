# CarePulse Chaos Scenarios — S10-01

Controlled fault injection via [Toxiproxy](https://github.com/Shopify/toxiproxy).
Each scenario stresses one or more SLOs defined in `docs/sre/error-budget-policy.md`.

## Prerequisites

```bash
make chaos-up     # starts Toxiproxy + registers the three proxies
```

Toxiproxy REST API: http://localhost:8474

## Scenarios

| File | Target | Toxic | SLO stressed |
|------|--------|-------|-------------|
| `kafka-lag.json` | Kafka `:19092` | 500 ms latency | alert-pipeline p99 latency |
| `postgres-slow.json` | Postgres `:15432` | 200 ms latency | patient-service p99 write |
| `redis-down.json` | Redis `:16379` | timeout (0 ms bandwidth) | alert publish non-critical path |
| `kafka-down.json` | Kafka `:19092` | 100% connection reset | DLQ fallback + error budget |

## Running a scenario

```bash
# Inject a toxic
make chaos-kafka-lag

# Run the drill runner (asserts SLO breach is observable)
make chaos-drill

# Remove all toxics (restore normal operation)
make chaos-reset
```

## Architecture

```
Services → Toxiproxy proxy port → real service
           └─ toxic injected here
```

Services must connect via the proxy port for chaos to take effect.
In local dev, set env vars:
- `KAFKA_BROKERS=localhost:19092`
- `DATABASE_URL=...@localhost:15432/carepack`
- `REDIS_URL=redis://localhost:16379`
