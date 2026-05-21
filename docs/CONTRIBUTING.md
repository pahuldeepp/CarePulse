# Contributing to CarePulse

## Branching

- `main` is protected. **No direct pushes** once GitHub branch protection is enabled (see Setup below).
- Work in `feat/<sprint-ticket>` / `fix/<sprint-ticket>` / `docs/<topic>` branches.
- One PR per concern. Squash-merge by default.

## Commits

Conventional Commits — `feat(service):`, `fix(service):`, `chore:`, `test:`, `docs:`. One scope per commit.

## PR workflow

1. Open PR using the template (`.github/pull_request_template.md`).
2. CodeRabbit + Copilot review run automatically once enabled.
3. For S11+ (HIPAA scope), require **two reviewers** including a code owner.
4. Run `/ultrareview` on the branch for high-risk changes (auth, RLS, escalation paths, billing).

## Branch protection — one-time setup (repo admin)

GitHub UI → **Settings → Branches → Branch protection rules** for `main`:

- [x] Require a pull request before merging
- [x] Require approvals: **1** (raise to **2** before S11)
- [x] Dismiss stale approvals on new commits
- [x] Require review from Code Owners
- [x] Require status checks: `ci-go`, `ci-node`, `ci-python`
- [x] Require branches to be up to date before merging
- [x] Require conversation resolution
- [x] Do not allow bypassing the above settings

After enabling, the only path to `main` is via PR. Direct push will be rejected.

## Self-verify before requesting review

Per `CLAUDE.md` self-verify pattern:

1. Run the service's test suite.
2. Type-check (`tsc --noEmit` / `go build ./...` / `ruff check`).
3. Verify the Kafka topic / DB table the feature writes to actually receives data.
4. Confirm OTel `trace_id` appears in log output.

For S9-08-class changes (anything in the alert escalation path), also run:

```
./scripts/integration/s9-08-alert-flow.sh
```
