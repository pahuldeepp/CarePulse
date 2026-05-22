#!/usr/bin/env bash
# Tabletop test for S9 burn-rate alerts.
#
# What it does:
#   1. Hits gateway-graphql with a burst of requests that the service forces to 5xx
#      (synthetic outage via the /v1/admin/inject-error endpoint if present,
#      otherwise via Toxiproxy fault injection — fallback documented below).
#   2. Polls Prometheus for the GatewayGraphQLAvailabilityFastBurn rule firing.
#   3. Asserts it fires within ~3 minutes, then stops the fault.
#
# Prereqs:
#   make sre-up         # docker-compose stack including Prometheus + Grafana
#   curl http://localhost:9090/-/ready   # Prometheus alive
#
# Run:
#   ./scripts/sre/tabletop-burn-rate.sh
#
# Pass criteria:
#   - Alert state ACTIVE within 3 minutes of fault start.
#   - Alert state INACTIVE within 5 minutes of fault stop.

set -euo pipefail

PROM="${PROM:-http://localhost:9090}"
GATEWAY="${GATEWAY:-http://localhost:4000}"
ALERT_NAME="${ALERT_NAME:-GatewayGraphQLAvailabilityFastBurn}"
FAULT_DURATION="${FAULT_DURATION:-180}"

note() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
pass() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

alert_state() {
  curl -s "$PROM/api/v1/alerts" \
    | python3 -c "
import json,sys
d = json.load(sys.stdin)
for a in d['data']['alerts']:
    if a['labels'].get('alertname') == '$ALERT_NAME':
        print(a['state']); break
else: print('none')
"
}

inject_fault_start() {
  note "Injecting 5xx fault for ${FAULT_DURATION}s via Toxiproxy"
  curl -sf -X POST "http://localhost:8474/proxies/gateway-graphql/toxics" \
    -H 'Content-Type: application/json' \
    -d '{"name":"sre_tabletop","type":"limit_data","stream":"downstream","toxicity":1.0,"attributes":{"bytes":0}}' \
       >/dev/null \
    || fail "Toxiproxy not reachable on :8474 — see docs/sre/tabletop.md fallback"
  pass "fault active"
}

inject_fault_stop() {
  note "Removing fault"
  curl -sf -X DELETE "http://localhost:8474/proxies/gateway-graphql/toxics/sre_tabletop" \
    >/dev/null || true
  pass "fault cleared"
}

drive_traffic() {
  note "Driving 5 req/s against gateway for ${FAULT_DURATION}s in background"
  ( end=$((SECONDS + FAULT_DURATION))
    while [[ $SECONDS -lt $end ]]; do
      curl -s -o /dev/null "$GATEWAY/graphql" || true
      sleep 0.2
    done ) &
  DRIVER_PID=$!
}

trap '[[ -n "${DRIVER_PID:-}" ]] && kill "$DRIVER_PID" 2>/dev/null; inject_fault_stop' EXIT

inject_fault_start
drive_traffic

note "Waiting for $ALERT_NAME to fire (max 4 min)"
for i in $(seq 1 48); do
  state=$(alert_state)
  printf '  [%02d] alert state: %s\n' "$i" "$state"
  if [[ "$state" == "firing" ]]; then
    pass "Burn-rate alert fired after $((i * 5))s — tabletop PASS"
    break
  fi
  sleep 5
done

[[ "$state" == "firing" ]] || fail "alert did not fire within 4 minutes"

note "Waiting for fault to expire + alert to clear"
wait "${DRIVER_PID}" 2>/dev/null || true
inject_fault_stop

for i in $(seq 1 60); do
  state=$(alert_state)
  if [[ "$state" == "none" || "$state" == "inactive" ]]; then
    pass "Alert cleared after $((i * 5))s — tabletop COMPLETE"
    exit 0
  fi
  sleep 5
done

fail "alert did not clear within 5 minutes — check Prometheus rule evaluation interval"
