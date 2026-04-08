# CarePulse

Multi-tenant healthcare SaaS — **reference architecture** in [`CarePulse_Healthcare_Blueprint_v1.pdf`](./CarePulse_Healthcare_Blueprint_v1.pdf).

## Monorepo on GitHub

**One repository** (**Carepack** / this tree) contains every microservice as its **own deployable folder** under `services/`, plus shared `contracts/`, `apps/web`, `packages/`, `infra/`, and `adr/`. This is a **monorepo** layout: multiple microservices, single Git remote.

| Area | Path | Blueprint |
|------|------|-----------|
| Web & portals | [`apps/web`](./apps/web) | Part I — Presentation (React/TypeScript) |
| Microservices | [`services/`](./services) | Part II — §5 Full Service Map |
| Shared libraries | [`packages/`](./packages) | Cross-cutting types, generated clients |
| API contracts | [`contracts/`](./contracts) | Part V — gRPC / OpenAPI / FHIR |
| Architecture docs | [`docs/architecture/`](./docs/architecture) | Repo ↔ PDF mapping |
| ADRs | [`adr/`](./adr) | Part IX — §46 ADR catalogue |
| Infrastructure | [`infra/`](./infra) | Part VII §39 — CI/CD, K8s, Terraform, GitOps |

Details: [`docs/architecture/REPO_STRUCTURE.md`](./docs/architecture/REPO_STRUCTURE.md).

## Tooling (root)

- `npm run lint` — ESLint (root/config tooling)
- `npm run claude` / `npm run codex` — AI CLIs
- See [`CLAUDE.md`](./CLAUDE.md) for agent context

## Confidentiality

The PDF is marked confidential; do not redistribute.
