# Service-Level Objectives

One file per service: `infra/slo/<service>.yaml`.

Schema (validated in CI — TODO S9-01):

```yaml
service: <name>
owner: <team-or-handle>
slos:
  - name: <short-name>
    sli:
      type: availability | latency
      good_query: <PromQL expression returning successful events>
      total_query: <PromQL expression returning all events>
    objective: 99.9       # percent
    window: 30d
    burn_rate_alerts:
      - severity: page
        long_window: 1h
        burn_rate: 14.4
      - severity: ticket
        long_window: 6h
        burn_rate: 6
```

Burn-rate thresholds follow the Google SRE workbook multi-window multi-burn-rate
recipe. A 14.4× burn over 1h exhausts 2% of a 30d budget — page-worthy.
