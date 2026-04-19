#!/usr/bin/env bash
# register-connector.sh — wait for Kafka Connect, then register the outbox connector.
# Run once after `docker compose up`. Safe to re-run (PUT idempotent).
set -euo pipefail

CONNECT_URL="${CONNECT_URL:-http://localhost:8083}"
CONNECTOR_NAME="carepack-outbox-connector"
CONFIG_FILE="$(dirname "$0")/outbox-connector.json"

echo "Waiting for Kafka Connect at ${CONNECT_URL}..."
until curl -sf "${CONNECT_URL}/connectors" > /dev/null 2>&1; do
  sleep 2
done
echo "Kafka Connect is ready."

# Use PUT so re-running is idempotent (creates or updates)
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT \
  -H "Content-Type: application/json" \
  --data-binary "@${CONFIG_FILE}" \
  "${CONNECT_URL}/connectors/${CONNECTOR_NAME}/config")

if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "201" ]]; then
  echo "Connector '${CONNECTOR_NAME}' registered (HTTP ${HTTP_STATUS})."
else
  echo "ERROR: connector registration failed (HTTP ${HTTP_STATUS})" >&2
  exit 1
fi

# Verify status
echo "Connector status:"
curl -sf "${CONNECT_URL}/connectors/${CONNECTOR_NAME}/status" | python3 -m json.tool
