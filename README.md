# CarePulse

Multi-tenant healthcare SaaS (patient/device monitoring, risk scoring, alerts, dashboards) — **reference architecture** per [`CarePulse_Healthcare_Blueprint_v1.pdf`](./CarePulse_Healthcare_Blueprint_v1.pdf).

## Repository layout

| Area | Path | Blueprint |
|------|------|-----------|
| Web & portals | [`apps/web`](./apps/web) | Part I — Presentation (React/TypeScript) |
| Backend services | [`services/`](./services) | Part II — §5 Full Service Map (13 services) |
| Shared libraries | [`packages/`](./packages) | Cross-cutting types, clients (TBD) |
| API contracts | [`contracts/`](./contracts) | Part V — gRPC / OpenAPI / FHIR shapes |
| Architecture docs | [`docs/architecture/`](./docs/architecture) | Repo ↔ PDF mapping |
| ADRs | [`adr/`](./adr) | Part IX — §46 ADR catalogue |
| Infrastructure | [`infra/`](./infra) | Part VII §39 — CI/CD, K8s, Terraform, GitOps |

Details: [`docs/architecture/REPO_STRUCTURE.md`](./docs/architecture/REPO_STRUCTURE.md).

## Tooling (root)

- `npm run lint` — ESLint (root/config tooling)
- `npm run claude` / `npm run codex` — AI CLIs
- See [`CLAUDE.md`](./CLAUDE.md) for agent context

## Confidentiality

The PDF is marked confidential; do not redistribute. This repo is the working implementation space.
