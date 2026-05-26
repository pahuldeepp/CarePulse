#!/usr/bin/env bash
# chaos-reset.sh — Remove all active toxics from every Toxiproxy proxy.
# Safe to run at any time; idempotent if no toxics are active.

set -euo pipefail

TOXI_URL="${TOXI_URL:-http://localhost:8474}"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

proxies=$(curl -sf "${TOXI_URL}/proxies" | python3 -c "
import sys, json
print(' '.join(json.load(sys.stdin).keys()))
")

if [ -z "$proxies" ]; then
  log "No proxies registered — nothing to reset."
  exit 0
fi

for proxy in $proxies; do
  toxics=$(curl -sf "${TOXI_URL}/proxies/${proxy}/toxics" | python3 -c "
import sys, json
for t in json.load(sys.stdin):
    print(t['name'])
" 2>/dev/null || true)

  if [ -z "$toxics" ]; then
    log "  ${proxy}: no active toxics"
    continue
  fi

  for toxic in $toxics; do
    curl -sf -X DELETE "${TOXI_URL}/proxies/${proxy}/toxics/${toxic}" > /dev/null
    log "  ${proxy}: removed toxic '${toxic}'"
  done
done

log "All toxics removed."
