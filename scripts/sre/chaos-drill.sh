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
SOAK_SECONDS=5     # seconds to hold before measuring (each scenario self-soaks as needed)
RESET_WAIT=10      # seconds to wait after reset before next scenario

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

# Measure Redis PING round-trip time in ms (actual data transfer, not just TCP connect)
measure_redis_rtt_ms() {
  local host="$1" port="$2"
  python3 -c "
import socket, time
try:
    s = socket.create_connection(('${host}', ${port}), timeout=10)
    t0 = time.monotonic()
    s.sendall(b'*1\r\n\$4\r\nPING\r\n')
    s.recv(64)
    print(int((time.monotonic() - t0) * 1000))
    s.close()
except Exception as e:
    print(9999)
"
}

# Measure Postgres round-trip time in ms (sends a simple query, waits for response)
measure_pg_rtt_ms() {
  local port="$1"
  local t_start t_end
  t_start=$(python3 -c "import time; print(int(time.monotonic()*1000))")
  PGPASSWORD=carepack psql -h localhost -p "$port" -U carepack -c "SELECT 1" carepack > /dev/null 2>&1 || true
  t_end=$(python3 -c "import time; print(int(time.monotonic()*1000))")
  echo $((t_end - t_start))
}

# Assert TCP connection to proxy is refused / times out (service down)
assert_connection_fails() {
  local label="$1" host="$2" port="$3"
  local result
  result=$(python3 -c "
import socket
try:
    s = socket.create_connection(('${host}', ${port}), timeout=3)
    s.close()
    print('connected')
except Exception as e:
    print('failed:' + str(e))
")
  if [[ "$result" == failed* ]]; then
    pass "${label}: connection blocked as expected (${result})"
  else
    fail "${label}: connection succeeded — toxic may not be active"
  fi
}

run_kafka_lag() {
  log "=== SCENARIO: kafka-lag ==="

  # Baseline RTT before toxic (direct port, no proxy)
  local baseline
  baseline=$(measure_redis_rtt_ms "localhost" "6379")
  log "  Pre-toxic Redis baseline RTT: ${baseline} ms (direct, used for calibration)"

  inject_toxic "kafka-lag"
  log "Toxic injected. Measuring Kafka proxy data-path latency..."
  sleep 2

  # Kafka latency toxic: measure data-path RTT via proxy using a Kafka API version request
  # nc sends the Kafka ApiVersions request (10 bytes) and the toxic delays the response
  local proxied_ms direct_ms
  direct_ms=$(python3 -c "
import socket, time, struct
req = struct.pack('>ihhi', 10, 18, 0, 1) + b'\x00\x00'  # ApiVersions v0
s = socket.create_connection(('localhost', 9092), timeout=5)
t0 = time.monotonic()
s.sendall(struct.pack('>i', len(req)) + req)
s.recv(1024)
print(int((time.monotonic()-t0)*1000))
s.close()
" 2>/dev/null || echo "9999")

  proxied_ms=$(python3 -c "
import socket, time, struct
req = struct.pack('>ihhi', 10, 18, 0, 1) + b'\x00\x00'
s = socket.create_connection(('localhost', 19092), timeout=10)
t0 = time.monotonic()
s.sendall(struct.pack('>i', len(req)) + req)
s.recv(1024)
print(int((time.monotonic()-t0)*1000))
s.close()
" 2>/dev/null || echo "9999")

  log "  Kafka direct RTT:  ${direct_ms} ms"
  log "  Kafka proxy RTT:   ${proxied_ms} ms  (toxic: +500 ms)"

  if python3 -c "import sys; sys.exit(0 if int('${proxied_ms}') > int('${direct_ms}') + 300 else 1)" 2>/dev/null; then
    pass "kafka-lag: proxy RTT ${proxied_ms}ms > direct ${direct_ms}ms + 300ms — toxic confirmed"
  else
    fail "kafka-lag: proxy RTT ${proxied_ms}ms not meaningfully above direct ${direct_ms}ms (expected +500ms)"
  fi

  assert_metric_above \
    "kafka-lag: Postgres unaffected (pg_up=1)" \
    "pg_up" "0"

  remove_toxic "kafka-lag"
  sleep "$RESET_WAIT"
}

run_postgres_slow() {
  log "=== SCENARIO: postgres-slow ==="

  # Baseline: query RTT on direct port before injecting
  local baseline
  baseline=$(measure_pg_rtt_ms "5432")
  log "  Postgres baseline query RTT: ${baseline} ms (direct port)"

  inject_toxic "postgres-slow"
  log "Toxic injected. Measuring Postgres query RTT through proxy..."
  sleep 2

  local proxied
  proxied=$(measure_pg_rtt_ms "15432")

  log "  Postgres direct RTT: ${baseline} ms"
  log "  Postgres proxy RTT:  ${proxied} ms  (toxic: +200 ms)"

  if python3 -c "import sys; sys.exit(0 if int('${proxied}') > int('${baseline}') + 100 else 1)"; then
    pass "postgres-slow: proxy RTT ${proxied}ms > baseline ${baseline}ms + 100ms — toxic confirmed"
  else
    fail "postgres-slow: proxy RTT ${proxied}ms not meaningfully above baseline ${baseline}ms (expected +200ms)"
  fi

  assert_metric_above \
    "postgres-slow: pg_up still 1 via direct port" \
    "pg_up" "0"

  assert_metric_above \
    "postgres-slow: pg_stat_activity_count > 0" \
    "pg_stat_activity_count" "0"

  remove_toxic "postgres-slow"
  sleep "$RESET_WAIT"
}

run_redis_down() {
  log "=== SCENARIO: redis-down ==="

  # Baseline PING RTT on direct port
  local baseline
  baseline=$(measure_redis_rtt_ms "localhost" "6379")
  log "  Redis baseline PING RTT: ${baseline} ms (direct port)"

  inject_toxic "redis-down"
  log "Toxic injected. Measuring Redis PING RTT through proxy (bandwidth=0)..."
  sleep 2

  # bandwidth=0 toxic: TCP connects, but no bytes flow → PING will hang until timeout
  local proxied
  proxied=$(measure_redis_rtt_ms "localhost" "16379")

  log "  Redis direct PING RTT: ${baseline} ms"
  log "  Redis proxy PING RTT:  ${proxied} ms  (toxic: zero bandwidth, expect timeout=9999)"

  if [ "$proxied" = "9999" ] || python3 -c "import sys; sys.exit(0 if int('${proxied}') > 5000 else 1)" 2>/dev/null; then
    pass "redis-down: PING timed out through proxy (${proxied}ms) — bandwidth blocked as expected"
  else
    fail "redis-down: PING succeeded in ${proxied}ms — bandwidth toxic may not be effective"
  fi

  assert_metric_above \
    "redis-down: Postgres unaffected (pg_up=1)" \
    "pg_up" "0"

  remove_toxic "redis-down"
  sleep "$RESET_WAIT"
}

run_kafka_down() {
  log "=== SCENARIO: kafka-down ==="
  inject_toxic "kafka-down"
  log "Toxic injected. Testing Kafka data-path through proxy (reset_peer)..."
  sleep 2

  # reset_peer resets the connection after data is sent — TCP connect succeeds,
  # but sending a Kafka request causes the connection to be reset immediately
  local result
  result=$(python3 -c "
import socket, struct, sys
try:
    req = struct.pack('>ihhi', 10, 18, 0, 1) + b'\x00\x00'
    s = socket.create_connection(('localhost', 19092), timeout=5)
    s.sendall(struct.pack('>i', len(req)) + req)
    data = s.recv(1024)
    if data:
        print('connected_with_data')
    else:
        print('connection_reset')
    s.close()
except ConnectionResetError:
    print('connection_reset')
except Exception as e:
    print('error:' + str(e))
" 2>/dev/null)

  log "  Kafka proxy result: ${result}"

  if [[ "$result" == "connection_reset" ]] || [[ "$result" == error* ]]; then
    pass "kafka-down: Kafka connection reset through proxy — toxic confirmed (${result})"
  else
    fail "kafka-down: Expected connection reset, got: ${result}"
  fi

  assert_metric_above \
    "kafka-down: Postgres unaffected (pg_up=1)" \
    "pg_up" "0"

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
