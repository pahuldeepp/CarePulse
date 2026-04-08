# CarePulse / Carepack

## What this is

Monorepo for **CarePulse** healthcare SaaS. Product context lives in **`CarePulse_Healthcare_Blueprint_v1.pdf`** (authoritative). **Repository layout** (services, `apps/web`, `contracts`, `infra`, `adr`) is documented in **`README.md`** and **`docs/architecture/REPO_STRUCTURE.md`**.

## Stack

- **Polyglot (target):** Go, NestJS/Express (TypeScript), FastAPI/Python, React/TypeScript — per blueprint §2.
- **Root tooling:** Node (CommonJS) for **Claude Code**, **Codex CLI**, **coderabbitai-mcp**, ESLint.

## Commands

- `npm run claude` — Claude Code (terminal agent).
- `npm run codex` — Codex CLI.
- `npm run lint` — ESLint.

## GitHub

Remote repo: **pahuldeepp/Carepack** (see `origin`).

## MCP: CodeRabbit

Project **`.mcp.json`** wires the CodeRabbit MCP server. Set **`GITHUB_PAT`** in your environment (classic PAT with `repo` or `public_repo` as needed) before starting Claude Code so that server can start. To verify the binary: `npx coderabbitai-mcp` (expects `GITHUB_PAT`).

## Safety

Do not commit secrets, API keys, or real PHI. Prefer env files (gitignored) and secure backends for any future health data.
