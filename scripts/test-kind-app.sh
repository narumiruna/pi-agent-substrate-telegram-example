#!/usr/bin/env bash
# No bootstrap, Argo Application creation, initial sync, fixture reset, or automatic cleanup.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# != 2 || ! "$1" =~ ^[0-9a-f]{40}$ || "$2" != --reviewed-runtime-gate ]]; then
  printf 'Usage: bash scripts/test-kind-app.sh FULL_REVIEWED_GIT_SHA --reviewed-runtime-gate\n' >&2
  printf 'Main must review the commit, complete initial Argo sync, and explicitly open the runtime gate.\n' >&2
  exit 2
fi
exec node tests/e2e/run.mjs "$1" "$2"
