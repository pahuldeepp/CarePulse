#!/usr/bin/env bash
# Run code-review-graph from project .venv (hooks / local tools).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/.venv/bin/code-review-graph" "$@"
