#!/usr/bin/env bash
# chaos-drill.sh — S10-01 CarePulse chaos drill runner
#
# Injects each chaos scenario in sequence, asserts the expected observable
# effect via Prometheus, then resets. Produces a pass/fail summary written
# to docs/postmortems/ for the game-day record.
#
# Usage:
#   ./scripts/sre/chaos-drill.sh [--scenario kafka-lag|postgres-slow|redis-down|kafka-down|all]
#
# Prerequisites:
#   make chaos-up   (Toxiproxy running + proxies registered)
#   Prometheus running at PROMETHEUS_URL (default http://localhost:9090)

set -euo pipefail

TOXI_URL="${TOXI_URL:-http://localhost:8474}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"
SCENARIO="${1:-all}"
REPORT_DIR="docs/postmortems"
REPORT_FILE="${REPORT_DIR}/$(date -u +%Y-%m-%d)-chaos-drill.md"
SOAK_SECONDS=60    # how long to hold each toxic before asserting
RESET_WAIT=15      # seconds to wait after reset before next scenario

PASS=0
FAIL=0
RESULTS=()

log()  { echo "[$(date -u +%H:%M:%S)] $*"; }
pass() { log "PASS — $*"; PASS=$((PASS+1)); RESULTS+=("✅ $*"); }
fail() { log "FAIL — $*"; FAIL=$((FAIL+1)); RESULTS+=("❌ $*"); }

check_toxi() {
  if ! curl -sf "${TOXI_URL}/version" > /dev/null; then
    echo "ERROR: Toxiproxy not reachable at ${TOXI_URL}. Run: make chaos-up"
    exit 1
  fi
}

register_proxies() {
  log "Registering Toxiproxy proxies..."
  for proxy in kafka postgres redis; do
    name=$(jq -r '.name' "chaos/proxies.json" 2>/dev/null || echo "$proxy")
  done
  # Register all three proxies from proxies.json (idempotent — 409 is OK)
  while IFS= read -r proxy_json; do
    name=$(echo "$proxy_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['name'])")
    curl -sf -X POST "${TOXI_URL}/proxies" \
      -H 'Content-Type: application/json' \
      -d "$proxy_json" > /dev/null 2>&1 || true
    log "  proxy registered: $name"
  done < <(python3 -c "
import json
proxies = json.load(open('chaos/proxies.json'))
for p in proxies:
    print(json.dumps(p))
")
}

inject_toxic() {
  local scenario_file="chaos/${1}.json"
  local proxy toxic_payload
  proxy=$(python3 -c "import json; d=json.load(open('${scenario_file}')); print(d['proxy'])")
  toxic_payload=$(python3 -c "import json; d=json.load(open('${scenario_file}')); print(json.dumps(d['toxic']))")

  log "Injecting toxic: ${1} → proxy=${proxy}"
  curl -sf -X POST "${TOXI_URL}/proxies/${proxy}/toxics" \
    -H 'Content-Type: application/json' \
    -d "$toxic_payload" > /dev/null
}

remove_toxic() {
  local scenario_file="chaos/${1}.json"
  local proxy toxic_name
  proxy=$(python3 -c "import json; d=json.load(open('${scenario_file}')); print(d['proxy'])")
  toxic_name=$(python3 -c "import json; d=json.load(open('${scenario_file}')); print(d['toxic']['name'])")

  log "Removing toxic: ${toxic_name} from proxy=${proxy}"
  curl -sf -X DELETE "${TOXI_URL}/proxies/${proxy}/toxics/${toxic_name}" > /dev/null 2>&1 || true
}

query_prometheus() {
  local query="$1"
  curl -sf "${PROMETHEUS_URL}/api/v1/query" \
    --data-urlencode "query=${query}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('data', {}).get('result', [])
if results:
    print(results[0]['value'][1])
else:
    print('no_data')
"
}

assert_metric_above() {
  local label="$1" query="$2" threshold="$3"
  local value
  value=$(query_prometheus "$query")
  if [ "$value" = "no_data" ]; then
    fail "${label}: no metric data — is the service instrumented and Prometheus scraping?"
    return
  fi
  if python3 -c "import sys; sys.exit(0 if float('${value}') > float('${threshold}') else 1)"; then
    pass "${label}: value=${value} > threshold=${threshold}"
  else
    fail "${label}: value=${value} not > threshold=${threshold}"
  fi
}

assert_metric_equals() {
  local label="$1" query="$2" expected="$3"
  local value
  value=$(query_prometheus "$query")
  if [ "$value" = "no_data" ]; then
    fail "${label}: no metric data"
    return
  fi
  if [ "$value" = "$expected" ]; then
    pass "${label}: value=${value}"
  else
    fail "${label}: value=${value} expected=${expected}"
  fi
}

run_kafka_lag() {
  log "=== SCENARIO: kafka-lag ==="
  inject_toxic "kafka-lag"
  log "Soaking for ${SOAK_SECONDS}s..."
  sleep "$SOAK_SECONDS"

  assert_metric_above \
    "kafka-lag: Kafka consumer lag > 0" \
    'sum(kafka_consumergroup_lag) > 0' \
    "0"

  remove_toxic "kafka-lag"
  sleep "$RESET_WAIT"
}

run_postgres_slow() {
  log "=== SCENARIO: postgres-slow ==="
  inject_toxic "postgres-slow"
  log "Soaking for ${SOAK_SECONDS}s..."
  sleep "$SOAK_SECONDS"

  assert_metric_above \
    "postgres-slow: pg query duration p99 > 0.1s" \
    'histogram_quantile(0.99, rate(pg_stat_statements_mean_exec_time_seconds_bucket[1m]))' \
    "0.1"

  remove_toxic "postgres-slow"
  sleep "$RESET_WAIT"
}

run_redis_down() {
  log "=== SCENARIO: redis-down ==="
  inject_toxic "redis-down"
  log "Soaking for ${SOAK_SECONDS}s..."
  sleep "$SOAK_SECONDS"

  log "INFO: redis-down scenario — asserting alerts are NOT lost (check app logs for redis_publish_failed)"
  log "      Prometheus metric check: workflow-alerts error counter"
  assert_metric_above \
    "redis-down: workflow-alerts logs error (redis_publish_failed)" \
    'increase(workflow_alerts_errors_total[1m])' \
    "0"

  remove_toxic "redis-down"
  sleep "$RESET_WAIT"
}

run_kafka_down() {
  log "=== SCENARIO: kafka-down ==="
  inject_toxic "kafka-down"
  log "Soaking for ${SOAK_SECONDS}s..."
  sleep "$SOAK_SECONDS"

  assert_metric_above \
    "kafka-down: error budget burn rate spiked" \
    'increase(http_requests_total{status=~"5.."}[1m])' \
    "0"

  remove_toxic "kafka-down"
  sleep "$RESET_WAIT"
}

write_report() {
  mkdir -p "$REPORT_DIR"
  cat > "$REPORT_FILE" <<EOF
# Chaos Drill Report — $(date -u +%Y-%m-%d)

**Run date:** $(date -u +"%Y-%m-%d %H:%M UTC")
**Operator:** ${USER}
**Scenario set:** ${SCENARIO}

## Results

| Status | Assertion |
|--------|-----------|
$(for r in "${RESULTS[@]}"; do echo "| ${r:0:1} | ${r:2} |"; done)

## Summary

- **Passed:** ${PASS}
- **Failed:** ${FAIL}
- **Total:**  $((PASS + FAIL))

## Observations

<!-- Fill in during/after the drill -->

## Action items

<!-- List any fixes needed based on failures -->

---
*Generated by scripts/sre/chaos-drill.sh*
EOF
  log "Report written to: ${REPORT_FILE}"
}

main() {
  check_toxi
  register_proxies

  case "$SCENARIO" in
    kafka-lag)     run_kafka_lag ;;
    postgres-slow) run_postgres_slow ;;
    redis-down)    run_redis_down ;;
    kafka-down)    run_kafka_down ;;
    all)
      run_kafka_lag
      run_postgres_slow
      run_redis_down
      run_kafka_down
      ;;
    *)
      echo "Unknown scenario: ${SCENARIO}"
      echo "Valid: kafka-lag | postgres-slow | redis-down | kafka-down | all"
      exit 1
      ;;
  esac

  echo ""
  log "===== DRILL COMPLETE ====="
  log "Passed: ${PASS}  Failed: ${FAIL}"
  write_report

  if [ "$FAIL" -gt 0 ]; then
    exit 1
  fi
}

main
