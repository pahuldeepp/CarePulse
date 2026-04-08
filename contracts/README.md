# contracts/

**Blueprint:** Part V — gRPC + Protobuf, REST/OpenAPI, FHIR.

Shared definitions used by multiple services **in this monorepo**:

- `proto/` — gRPC services (internal mesh)
- `openapi/` — Partner REST + SDK generation
- `fhir/` — FHIR R4 resource profiles / extensions

Generate stubs into `packages/` or per-service `src/generated/` from CI.
