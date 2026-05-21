#!/usr/bin/env bash
# End-to-end integration test for S9-08 alert flow.
#
# Verifies: Postgres alert row → outbox_events row → Debezium → Kafka
#           → alert-projector → DynamoDB Local row + processed_events row.
#
# Prereqs (run from repo root):
#   docker compose -f infra/docker/docker-compose.yml up -d \
#     postgres kafka kafka-connect debezium dynamodb-local
#   ./infra/docker/debezium/register-connector.sh
#   (cd services/workflow-alerts && npm run dev) &  # or `docker compose up workflow-alerts`
#
# Run:
#   ./scripts/integration/s9-08-alert-flow.sh
#
# Exit 0 = all assertions passed.

set -euo pipefail

PG_DSN="${PG_DSN:-postgresql://carepack:carepack@localhost:5432/carepack}"
KAFKA_BOOTSTRAP="${KAFKA_BOOTSTRAP:-localhost:9092}"
DYNAMO_ENDPOINT="${DYNAMO_ENDPOINT:-http://localhost:8000}"
DYNAMO_TABLE="${DYNAMO_TABLE:-carepulse-alerts}"
TENANT_ID="${TENANT_ID:-11111111-1111-1111-1111-111111111111}"
ALERT_ID="$(uuidgen | tr 'A-Z' 'a-z')"

note() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
pass() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }

note "Publishing synthetic risk.scored event for alert_id=$ALERT_ID"
cat <<EOF | docker compose -f infra/docker/docker-compose.yml exec -T kafka \
    kafka-console-producer --bootstrap-server "$KAFKA_BOOTSTRAP" \
    --topic domain.risk.scored
{"device_id":"dev-integration","tenant_id":"$TENANT_ID","news2":8,"qsofa":2,"risk_level":"high","scored_at":"$(date -u +%FT%TZ)","emit_alert":true}
EOF

note "Waiting 5s for workflow-alerts to consume + write Postgres + outbox"
sleep 5

note "Assertion 1: Postgres alert row exists"
COUNT=$(psql "$PG_DSN" -tAc "SET app.current_tenant_id = '$TENANT_ID'; SELECT COUNT(*) FROM alerts WHERE tenant_id = '$TENANT_ID' AND triggered_at > now() - interval '1 minute'")
[[ "$COUNT" -ge 1 ]] || fail "no alert row in Postgres (got count=$COUNT)"
pass "Postgres alert row present"

note "Assertion 2: outbox_events row written in same transaction"
COUNT=$(psql "$PG_DSN" -tAc "SET app.current_tenant_id = '$TENANT_ID'; SELECT COUNT(*) FROM outbox_events WHERE aggregate_type = 'Alert' AND event_type = 'AlertCreated' AND created_at > now() - interval '1 minute'")
[[ "$COUNT" -ge 1 ]] || fail "no outbox row (count=$COUNT)"
pass "outbox_events row present"

note "Waiting 5s for Debezium → Kafka → alert-projector → DynamoDB"
sleep 5

note "Assertion 3: DynamoDB Local has the projected alert"
ITEM=$(aws --endpoint-url "$DYNAMO_ENDPOINT" dynamodb scan \
    --table-name "$DYNAMO_TABLE" \
    --filter-expression "tenant_id = :t" \
    --expression-attribute-values "{\":t\":{\"S\":\"$TENANT_ID\"}}" \
    --query 'Count' --output text)
[[ "$ITEM" -ge 1 ]] || fail "no DynamoDB item for tenant_id=$TENANT_ID"
pass "DynamoDB row present"

note "Assertion 4: processed_events recorded the outbox event"
PROCESSED=$(psql "$PG_DSN" -tAc "SELECT COUNT(*) FROM processed_events WHERE processed_at > now() - interval '1 minute'")
[[ "$PROCESSED" -ge 1 ]] || fail "processed_events empty"
pass "processed_events row present"

note "Assertion 5: DLQ topic has no messages from this run"
DLQ_COUNT=$(docker compose -f infra/docker/docker-compose.yml exec -T kafka \
    kafka-run-class kafka.tools.GetOffsetShell \
    --broker-list "$KAFKA_BOOTSTRAP" --topic cdc.outbox.events.dlq --time -1 2>/dev/null \
    | awk -F: '{sum+=$3} END {print sum+0}' || echo 0)
[[ "$DLQ_COUNT" -eq 0 ]] || fail "DLQ has $DLQ_COUNT messages — projection failed for some envelope"
pass "DLQ clean"

printf '\n\033[1;32mAll assertions passed.\033[0m\n'
