# Runbook: gateway-graphql availability burn

**Owner:** platform
**Severity:** page (fast burn) | ticket (slow burn)
**Linked SLO:** `gateway-graphql.availability` (99.9% / 30d)

## Symptoms

- Alert `GatewayGraphQLAvailabilityFastBurn` or `…SlowBurn` firing.
- 5xx rate visible on the SLO dashboard panel.
- Clients report failed GraphQL requests.

## Diagnosis

```promql
sum by (code) (rate(http_requests_total{service="gateway-graphql"}[5m]))
```

```promql
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket{service="gateway-graphql"}[5m])) by (le))
```

Check downstream health — gateway 5xx is usually a symptom:

- patient-service `/healthz`
- workflow-alerts `/healthz`
- Postgres connection saturation (`pg_stat_activity`)
- Kafka broker health (the gateway publishes via outbox; broker outage trips writes)

OTel: search `service.name=gateway-graphql status_code=ERROR` for the top failing operation.

## Mitigations

1. **Bad deploy?** `kubectl rollout undo deployment/gateway-graphql` — verify error rate drops within 2m.
2. **Downstream saturation?** Scale the saturated service (`kubectl scale --replicas=…`); gateway recovers automatically.
3. **Postgres pool exhausted?** Confirm `pg_stat_activity`; bounce gateway pods to reset pool. Investigate slow queries via [slow-queries.json](../../infra/docker/grafana/dashboards/slow-queries.json).
4. **Single bad tenant?** Rate-limit at the gateway (feature flag `tenant_throttle`) — quarantine, don't bring everyone down.

## Rollback

```bash
kubectl rollout undo deployment/gateway-graphql
kubectl rollout status deployment/gateway-graphql
```

Confirm: 5xx rate < 0.1% sustained for 10m.

## Post-incident

Postmortem in `docs/postmortems/YYYY-MM-DD-gateway-availability.md`.
