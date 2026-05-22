# `/metrics` instrumentation pattern

Each service exposes Prometheus metrics on `/metrics` so the burn-rate alerts in
[infra/docker/prometheus/rules/burn-rate.yml](../../infra/docker/prometheus/rules/burn-rate.yml)
have data to fire on. Without this, the SLO catalogue is decoration.

**Reference implementation:** [gateway-graphql](../../services/gateway-graphql/src/middleware/metrics.js).
Per-stack pattern below; copy/adapt.

## Required metrics

Every service must export:

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` (HTTP services) **or** `<domain>_total` (consumers) | Counter | `service`, `code`/`status` |
| `http_request_duration_seconds` (HTTP) **or** `<domain>_duration_seconds` (consumers) | Histogram | `service`, plus contextual labels |
| Default process metrics (CPU, memory, FDs) | Gauges | `service` |

The `service` label is set via the Prometheus scrape `relabel_configs` already
in [prometheus.yml](../../infra/docker/prometheus/prometheus.yml), but apps
should also set it as a default registry label so it survives federation.

## Express / NestJS (Node)

Use [prom-client](https://github.com/siimon/prom-client). See
[gateway-graphql/src/middleware/metrics.js](../../services/gateway-graphql/src/middleware/metrics.js) — direct copy works.

For NestJS, mount the middleware in `main.ts`:
```ts
const { instrument, metricsHandler } = require('./middleware/metrics');
app.use(instrument);
app.use('/metrics', metricsHandler);
```

Per-service tickets:
- **patient-service** (NestJS) — copy + add custom counter `outbox_publish_duration_seconds`
- **billing-service** (NestJS) — copy + add `stripe_webhook_processed_total{status}`
- **workflow-alerts** (NestJS) — copy + add `alerts_created_total{status}`; consumer-lag gauge auto-emitted by kafkajs prometheus reporter

## Go services

Use [`github.com/prometheus/client_golang/prometheus/promhttp`](https://pkg.go.dev/github.com/prometheus/client_golang/prometheus/promhttp):

```go
import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var httpRequests = promauto.NewCounterVec(
    prometheus.CounterOpts{Name: "http_requests_total"},
    []string{"method", "route", "code"},
)

http.Handle("/metrics", promhttp.Handler())
```

Wrap your router with a middleware that increments `httpRequests` per request.

Per-service tickets:
- **telemetry-ingest, asset-registry, projection-builder, saga-orchestrator, read-model-builder** — same pattern

## FastAPI (Python)

Use [`prometheus-fastapi-instrumentator`](https://github.com/trallnag/prometheus-fastapi-instrumentator):

```python
from prometheus_fastapi_instrumentator import Instrumentator
Instrumentator().instrument(app).expose(app)
```

That single call adds `/metrics`, `http_requests_total`, and a duration histogram.

Per-service tickets:
- **risk-engine, fhir-gateway, search-indexer** — three-line addition each

## Verification per service

After wiring:

```bash
curl -s http://localhost:<port>/metrics | grep -E '^http_requests_total|^process_'
```

Expect at least one `http_requests_total` series and process metrics. Then check
Prometheus picks it up: `http://localhost:9090/targets` — the service should be
UP.

## Open tickets

Track follow-up per service in [docs/sprints/S9-S10.md](../sprints/S9-S10.md)
under S9-04. The pattern above means each service is ≈30 minutes of work plus
test wiring; mechanical, not architectural.
