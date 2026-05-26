# CarePulse On-Call Guide

> You just got paged at 2 AM. This document tells you exactly what to do.

---

## Quick Links

| Tool | URL | Credentials |
|------|-----|-------------|
| Grafana (SLO dashboard) | http://localhost:3000/d/carepulse-slo | admin / carepack |
| Grafana (uptime dashboard) | http://localhost:3000/d/carepulse-uptime | admin / carepack |
| Prometheus (targets) | http://localhost:9090/targets | — |
| Prometheus (alerts) | http://localhost:9090/alerts | — |
| Blackbox probes | http://localhost:9115 | — |
| Kafka Connect REST | http://localhost:8088/connectors | — |
| OpenSearch | http://localhost:9200/_cluster/health | — |

---

## Escalation Tiers

| Tier | Who | When to call | Response SLA |
|------|-----|-------------|--------------|
| **L1** | On-call engineer (you) | First responder — all pages | Acknowledge within 5 min |
| **L2** | Senior engineer / tech lead | L1 cannot resolve in 30 min, or P0 patient impact | Wake up, join call |
| **L3** | Engineering manager + clinical lead | Data loss, prolonged outage > 1h, regulatory risk | Immediate |

> **P0 patient impact** = alert delivery delayed or lost, clinician unable to access patient data.
> Always escalate to L2 immediately for P0 — do not wait 30 minutes.

---

## First 5 Minutes Checklist

When you get paged, do these in order before waking anyone else up:

```
1. Open Grafana uptime dashboard → which service is red?
2. Open Prometheus /alerts → which alert fired?
3. Check service logs (see Log Commands below)
4. Check if it's a dependency (Kafka / Postgres / Redis down?)
5. Attempt restart (see Restart Commands below)
6. If not resolved in 15 min → escalate to L2
```

---

## Alert → Runbook Mapping

| Alert name | Severity | Runbook |
|------------|----------|---------|
| `ServiceHealthProbeDown` | page | [Service down](#service-health-probe-down) (below) |
| `ServiceHealthProbeSlow` | warning | [Service slow](#service-health-probe-slow) (below) |
| `GatewayGraphQLAvailabilityFastBurn` | page | [gateway-graphql-availability.md](./gateway-graphql-availability.md) |
| `GatewayGraphQLAvailabilitySlowBurn` | warning | [gateway-graphql-availability.md](./gateway-graphql-availability.md) |
| `KafkaConsumerLagHigh` | page | [kafka-consumer-lag.md](./kafka-consumer-lag.md) |
| `DebeziumConnectorDown` | page | [debezium-connector-down.md](./debezium-connector-down.md) |

---

## Runbooks

### Service Health Probe Down

**Alert:** `ServiceHealthProbeDown`
**Meaning:** A service's `/health` endpoint stopped returning 200 for > 1 minute.

**Step 1 — Identify which service**
```bash
# Check Grafana uptime dashboard — red chip = down service
open http://localhost:3000/d/carepulse-uptime

# Or query Prometheus directly
curl -s 'http://localhost:9090/api/v1/query?query=probe_success{job="blackbox-health"}==0' \
  | python3 -c "import sys,json; [print(r['metric']['instance']) for r in json.load(sys.stdin)['data']['result']]"
```

**Step 2 — Check logs**
```bash
# NestJS services (workflow-alerts, patient-service, billing-service)
cd services/workflow-alerts && npm run start:dev   # check startup errors

# Go services (telemetry-ingest, saga-orchestrator)
cd services/telemetry-ingest && go run ./cmd/server

# Python services (risk-engine, fhir-gateway)
cd services/risk-engine && uvicorn main:app --port 8001
cd services/fhir-gateway && uvicorn main:app --port 8002
```

**Step 3 — Check dependencies**
```bash
# Is Postgres up?
docker compose -f infra/docker/docker-compose.yml ps postgres

# Is Kafka up?
docker compose -f infra/docker/docker-compose.yml ps kafka

# Is Redis up?
docker compose -f infra/docker/docker-compose.yml ps redis

# Restart the whole infra stack if needed
make sre-up
```

**Step 4 — Restart the service**
```bash
# If running as Docker service
docker compose -f infra/docker/docker-compose.yml restart <service-name>

# Check probe recovers within 30s
curl -s 'http://localhost:9090/api/v1/query?query=probe_success{job="blackbox-health"}' \
  | python3 -c "import sys,json; [print(r['metric']['instance'], r['value'][1]) for r in json.load(sys.stdin)['data']['result']]"
```

**Escalate to L2 if:** Service won't start after restart, logs show panic/OOM, Postgres or Kafka is down.

---

### Service Health Probe Slow

**Alert:** `ServiceHealthProbeSlow`
**Meaning:** A service is responding to `/health` in > 2 seconds — it's up but degraded.

**Step 1 — Check resource usage**
```bash
# Check if the host is under memory/CPU pressure
docker stats --no-stream

# Check Postgres connection count (connection leak?)
curl -s 'http://localhost:9090/api/v1/query?query=pg_stat_activity_count' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['result'])"
```

**Step 2 — Check slow queries**
```bash
# Open Grafana slow-query dashboard
open http://localhost:3000/d/carepulse-slow-queries
```

**Step 3 — Check Kafka consumer lag**
```bash
docker exec carepack-kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 --describe --all-groups 2>/dev/null | grep -v EMPTY
```

**Escalate to L2 if:** Probe latency > 5s, memory growing continuously (leak), Postgres connections > 80% of max.

---

## Log Commands

```bash
# Docker infra logs
docker logs carepack-postgres --tail=50
docker logs carepack-kafka --tail=50
docker logs carepack-redis --tail=50
docker logs carepack-connect --tail=50

# Check Debezium connector status
curl -s http://localhost:8088/connectors/carepack-outbox/status | python3 -m json.tool

# Check all Kafka topics
docker exec carepack-kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --list

# Check DLQ topic for failed events
docker exec carepack-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic cdc.outbox.events.dlq \
  --from-beginning --max-messages 10
```

---

## Restart Commands

```bash
# Restart full observability + infra stack
make sre-up

# Restart individual infra containers
docker compose -f infra/docker/docker-compose.yml restart postgres
docker compose -f infra/docker/docker-compose.yml restart kafka
docker compose -f infra/docker/docker-compose.yml restart redis
docker compose -f infra/docker/docker-compose.yml restart connect

# Restart Toxiproxy (chaos) if a drill left toxics active
make chaos-reset
docker compose -f infra/docker/docker-compose.yml restart toxiproxy
```

---

## After the Incident

1. **Write a postmortem** using `docs/postmortems/_template.md`
2. **Save it** as `docs/postmortems/YYYY-MM-DD-short-title.md`
3. **File action items** as GitHub issues with label `incident`
4. **Update this runbook** if a step was missing or wrong
5. **Update the alert→runbook mapping** table above if a new alert fired

---

## Contact List

| Role | Name | Contact | Hours |
|------|------|---------|-------|
| On-call engineer | _(rotate weekly)_ | PagerDuty | 24/7 |
| Tech lead | _(fill in)_ | _(fill in)_ | Business hours + P0 |
| Engineering manager | _(fill in)_ | _(fill in)_ | P0 only |
| Clinical safety lead | _(fill in)_ | _(fill in)_ | P0 patient impact |

> Fill in real names and contacts before go-live. Never store phone numbers in git — use PagerDuty or your team's secure contact directory.
