# Runbook: <alert or symptom>

**Owner:** <team>
**Severity:** page | ticket
**Linked SLO:** `<service>.<slo-name>`

## Symptoms

What the on-call sees: alert text, dashboard panel, user report.

## Diagnosis

Step-by-step checks. Prefer copy-pasteable commands.

```bash
# Kafka consumer lag
kubectl exec -it kafka-0 -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 --describe --group <group>
```

```promql
# Error rate over last 15m
sum(rate(http_requests_total{service="<svc>",code=~"5.."}[15m]))
  / sum(rate(http_requests_total{service="<svc>"}[15m]))
```

Trace lookup:

```
OTel trace search: service.name="<svc>" status_code=ERROR
```

## Mitigations

Ordered by reversibility — try the safest first.

1. <action> — expected effect, how to verify.
2. <action> — …

## Rollback

Exact commands. Include the commit/tag to roll back to and how to confirm it took.

## Post-incident

- File a postmortem from `docs/postmortems/_template.md` within 48h.
- Update this runbook if any step was wrong or missing.
