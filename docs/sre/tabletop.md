# Running the SRE tabletop test

The tabletop validates that a synthetic outage actually fires the burn-rate
alerts wired in [burn-rate.yml](../../infra/docker/prometheus/rules/burn-rate.yml).
If it doesn't fire, the alerts are decorative; finding that out during a real
incident is the wrong moment.

## Prereqs

```bash
make sre-up                # docker compose stack
make sre-status            # wait until prometheus + grafana are healthy
make sre-prometheus        # confirm targets are UP
```

All 7 services should appear UP on the Prometheus targets page. If any are
DOWN: the service either isn't running or isn't exposing `/metrics` — check
the per-service instrumentation per [metrics-instrumentation.md](metrics-instrumentation.md).

## Run

```bash
make sre-tabletop
```

What it does:

1. Injects a synthetic 5xx burst against gateway-graphql via Toxiproxy
   (3 minutes by default; configurable via `FAULT_DURATION` env).
2. Polls Prometheus alerts API for `GatewayGraphQLAvailabilityFastBurn`.
3. Asserts the alert reaches `firing` state within 4 minutes.
4. Removes the fault and asserts the alert clears within 5 minutes.

Pass = exit 0 with green checkmarks. Fail = red message with what went wrong.

## Watching it in Grafana

While the script runs, open the SLO dashboard:

```bash
make sre-grafana
```

You should see:

- **Error-budget burn (1h)** panel: gateway-graphql line spikes above the
  red threshold (14.4×).
- **Remaining error budget** gauge: gateway-graphql tile drops toward red.

Both should recover after the script removes the fault.

## Fallback if Toxiproxy isn't available

If your docker-compose doesn't include Toxiproxy yet, the simplest
substitute is to stop the gateway and let the synthetic probe fail:

```bash
docker compose -f infra/docker/docker-compose.yml stop gateway-graphql
# Wait 3 minutes
docker compose -f infra/docker/docker-compose.yml start gateway-graphql
```

This produces a coarser test (probe failures vs. real 5xx traffic), but the
alert should still fire and clear. Use as a smoke test, not a substitute.

## What "PASS" means and doesn't mean

PASS = the alert pipeline (metrics → Prometheus → rule eval → alerts API)
is wired correctly end-to-end. It does **not** mean somebody got paged —
Alertmanager → PagerDuty/Opsgenie integration is S10 work.
