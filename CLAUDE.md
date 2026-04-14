# CarePulse / Carepack

## What this is

**Monorepo** for **CarePulse**: one GitHub repo containing **multiple microservice directories** under `services/`, plus `apps/web`, `contracts/`, `packages/`, `infra/`, `adr/`, and the blueprint PDF. See **`README.md`** and **`docs/architecture/REPO_STRUCTURE.md`**.

## Stack

- **Polyglot (target):** Go, NestJS/Express (TypeScript), FastAPI/Python, React/TypeScript — per blueprint §2.
- **Root tooling:** Node (CommonJS) for **Claude Code**, **Codex CLI**, **coderabbitai-mcp**, ESLint.

## Commands

- `npm run claude` — Claude Code (terminal agent).
- `npm run codex` — Codex CLI.
- `npm run lint` — ESLint.

## GitHub

Remote: **pahuldeepp/Carepack** — single repo for the whole monorepo.

## MCP: CodeRabbit

Project **`.mcp.json`** wires the CodeRabbit MCP server. Set **`GITHUB_PAT`** in your environment before starting Claude Code.

## Safety

Do not commit secrets, API keys, or real PHI. Prefer env files (gitignored) and secure backends for any future health data.

## Current Sprint

**S4 — Risk engine + FHIR stub + projection hardening (Wk 7-8)**

Next up → S5: Debezium CDC + outbox pipeline (Wk 9-10)

Completed: S1 monorepo bootstrap, S2 core write/read/auth, S3 NestJS domain services + alert pipeline + AWS (DynamoDB/S3/Lambda/CDK).

## Coding Standards

- **Commits:** Always use Conventional Commits — `feat(service):`, `fix(service):`, `chore:`, `test:`, `docs:`
- **No inline comments** in production code — code should be self-documenting; use comments only for non-obvious algorithmic decisions
- **No dead code** — delete it, don't comment it out
- **Error handling:** Every async function must handle errors explicitly — no silent swallows
- **Env vars:** Never hardcode — always `os.getenv()` / `process.env` with a sensible default or startup panic
- **Tests:** Every new service file needs a corresponding test file — Go `_test.go`, Python `test_*.py`, Node `*.spec.ts`

## Self-Verify Pattern

After writing any feature, always:
1. Run the service's test suite
2. Check types compile (`go build ./...` / `tsc --noEmit` / `ruff check`)
3. Verify the Kafka topic or DB table the feature writes to actually receives data
4. Confirm OTel trace_id appears in the log output

## Service Test Commands

```bash
# Go services
cd services/<name> && go test ./... -v

# Python services (risk-engine, fhir-gateway, search-indexer)
cd services/<name> && python -m pytest -v

# NestJS services (patient-service, workflow-alerts, billing-service)
cd services/<name> && npm test

# Lint all
npm run lint
cd services/risk-engine && ruff check .
cd services/<go-service> && golangci-lint run
```

## Playwright MCP (S12 E2E tests)

Playwright MCP is wired in `.mcp.json`. Use it for:
- Login → dashboard → acknowledge alert → check audit trail
- Clinician risk score flow
- Admin tenant management

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
