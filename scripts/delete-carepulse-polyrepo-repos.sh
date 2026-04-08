#!/usr/bin/env bash
# Deletes the extra carepulse-* GitHub repos (polyrepo experiment). Keeps Carepack.
#
# Prerequisite (one-time, opens browser):
#   gh auth refresh -h github.com -s delete_repo
#
# Then:
#   bash scripts/delete-carepulse-polyrepo-repos.sh

set -euo pipefail
OWNER="pahuldeepp"
REPOS=(
  carepulse-gateway-graphql
  carepulse-telemetry-ingest
  carepulse-projection-builder
  carepulse-asset-registry
  carepulse-read-model-builder
  carepulse-saga-orchestrator
  carepulse-patient-service
  carepulse-workflow-alerts
  carepulse-billing-service
  carepulse-risk-engine
  carepulse-fhir-gateway
  carepulse-search-indexer
  carepulse-jobs-worker
  carepulse-notification-service
  carepulse-web
  carepulse-contracts
)

for r in "${REPOS[@]}"; do
  echo "Deleting $OWNER/$r ..."
  gh repo delete "$OWNER/$r" --yes
done
echo "Done. Monorepo remains at https://github.com/$OWNER/Carepack"
