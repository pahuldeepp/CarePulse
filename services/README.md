# Backend services

Polyglot microservices from **CarePulse_Healthcare_Blueprint_v1.pdf** §4 (service layer) and §5 (full map).

| Service | Folder |
|---------|--------|
| GraphQL API gateway | [`gateway-graphql`](./gateway-graphql) |
| Telemetry ingest | [`telemetry-ingest`](./telemetry-ingest) |
| CQRS projection consumer | [`projection-builder`](./projection-builder) |
| Device/ward/site registry | [`asset-registry`](./asset-registry) |
| Read-model / MV builder | [`read-model-builder`](./read-model-builder) |
| Saga orchestrator | [`saga-orchestrator`](./saga-orchestrator) |
| Patient domain | [`patient-service`](./patient-service) |
| Alerts & workflows | [`workflow-alerts`](./workflow-alerts) |
| Billing | [`billing-service`](./billing-service) |
| Risk / ML scoring | [`risk-engine`](./risk-engine) |
| FHIR R4 | [`fhir-gateway`](./fhir-gateway) |
| OpenSearch indexer | [`search-indexer`](./search-indexer) |
| Background jobs | [`jobs-worker`](./jobs-worker) |
| Notifications | [`notification-service`](./notification-service) |

See [`../docs/architecture/REPO_STRUCTURE.md`](../docs/architecture/REPO_STRUCTURE.md) for the full repo map.
