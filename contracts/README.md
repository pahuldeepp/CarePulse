# contracts/

**Blueprint:** Part V — gRPC + Protobuf, REST/OpenAPI, FHIR.

Place shared definitions here:

- `proto/` — gRPC services (internal mesh)
- `openapi/` — Partner REST + SDK generation
- `fhir/` — FHIR R4 resource profiles / extensions (as code or JSON)

Keep services thin: generate language-specific stubs into each service or into `packages/`.
