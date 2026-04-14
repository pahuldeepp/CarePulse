#!/usr/bin/env bash
# replay-projection.sh — reset a projection and rebuild it from the Kafka log.
#
# Usage:
#   ./scripts/replay-projection.sh <projection>
#
# Available projections:
#   patient   — resets patient_dashboard_projection from patient.created
#   risk      — resets patient_risk_latest from domain.risk.scored
#   all       — resets both projections
#
# Examples:
#   ./scripts/replay-projection.sh patient
#   ./scripts/replay-projection.sh risk
#   ./scripts/replay-projection.sh all
#   ./scripts/replay-projection.sh patient --dry-run

set -euo pipefail

PROJECTION="${1:-}"
DRY_RUN="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

KAFKA_BOOTSTRAP="${KAFKA_BOOTSTRAP:-localhost:9092}"
DATABASE_URL="${DATABASE_URL:-postgres://carepack:carepack@localhost:5432/carepack?sslmode=disable}"

if [[ -z "$PROJECTION" ]]; then
  echo "Usage: $0 <patient|risk|all> [--dry-run]"
  echo ""
  echo "  patient  → reset patient_dashboard_projection"
  echo "  risk     → reset patient_risk_latest"
  echo "  all      → reset both"
  exit 1
fi

run_replay() {
  local group="$1"
  local topic="$2"
  local tables="$3"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Replaying: group=$group  topic=$topic"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  KAFKA_BOOTSTRAP="$KAFKA_BOOTSTRAP" \
  DATABASE_URL="$DATABASE_URL" \
  go run "$SCRIPT_DIR/replay-projection/main.go" \
    --brokers "$KAFKA_BOOTSTRAP" \
    --group   "$group" \
    --topic   "$topic" \
    --tables  "$tables" \
    --db      "$DATABASE_URL" \
    $DRY_RUN
}

case "$PROJECTION" in
  patient)
    run_replay \
      "projection-builder" \
      "patient.created" \
      "patient_dashboard_projection,processed_events"
    ;;

  risk)
    run_replay \
      "projection-builder-risk" \
      "domain.risk.scored" \
      "patient_risk_latest,processed_events"
    ;;

  all)
    run_replay \
      "projection-builder" \
      "patient.created" \
      "patient_dashboard_projection"

    run_replay \
      "projection-builder-risk" \
      "domain.risk.scored" \
      "patient_risk_latest"

    # Clear shared idempotency table once after both resets
    echo ""
    echo "  Clearing shared processed_events table..."
    psql "$DATABASE_URL" -c "TRUNCATE TABLE processed_events CASCADE;" \
      && echo "  ✓ processed_events cleared"
    ;;

  *)
    echo "Unknown projection: $PROJECTION"
    echo "Use: patient | risk | all"
    exit 1
    ;;
esac

echo ""
echo "✓ Replay complete. Now restart your consumer:"
echo ""
echo "  docker compose restart projection-builder"
echo "  docker compose restart read-model-builder"
echo ""
echo "  Watch rebuild:"
echo "  docker compose logs -f projection-builder read-model-builder"
echo ""
