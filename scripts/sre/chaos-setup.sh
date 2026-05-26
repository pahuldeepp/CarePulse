#!/usr/bin/env bash
# chaos-setup.sh — Start Toxiproxy and register the three service proxies.
# Run once after `make chaos-up` before running any scenario.
#
# Usage: ./scripts/sre/chaos-setup.sh

set -euo pipefail

TOXI_URL="${TOXI_URL:-http://localhost:8474}"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

wait_for_toxi() {
  log "Waiting for Toxiproxy at ${TOXI_URL}..."
  local attempts=0
  until curl -sf "${TOXI_URL}/version" > /dev/null; do
    attempts=$((attempts+1))
    if [ "$attempts" -ge 20 ]; then
      echo "ERROR: Toxiproxy did not become ready. Run: make chaos-up"
      exit 1
    fi
    sleep 2
  done
  version=$(curl -sf "${TOXI_URL}/version")
  log "Toxiproxy ready: ${version}"
}

register_proxy() {
  local name="$1" listen="$2" upstream="$3"
  local result
  result=$(curl -sf -o /dev/null -w "%{http_code}" -X POST "${TOXI_URL}/proxies" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"${name}\",\"listen\":\"0.0.0.0:${listen}\",\"upstream\":\"${upstream}\",\"enabled\":true}")

  if [ "$result" = "201" ]; then
    log "  registered proxy: ${name} (${listen} → ${upstream})"
  elif [ "$result" = "409" ]; then
    log "  proxy already exists: ${name} (OK)"
  else
    log "  WARNING: unexpected status ${result} for proxy ${name}"
  fi
}

wait_for_toxi

log "Registering service proxies..."
register_proxy "kafka"    "19092" "kafka:9092"
register_proxy "postgres" "15432" "postgres:5432"
register_proxy "redis"    "16379" "redis:6379"

log ""
log "Toxiproxy setup complete. Proxy ports:"
log "  Kafka:    localhost:19092 → kafka:9092"
log "  Postgres: localhost:15432 → postgres:5432"
log "  Redis:    localhost:16379 → redis:6379"
log ""
log "Run a chaos scenario:"
log "  make chaos-kafka-lag"
log "  make chaos-postgres-slow"
log "  make chaos-redis-down"
log "  make chaos-drill        (all scenarios + assertions)"
