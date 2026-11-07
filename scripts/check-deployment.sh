#!/usr/bin/env bash
# Deterministic packaging checks; --server adds read-only owned-cluster dry-runs.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
state="$root/.cache/deployment"
helm="$root/.cache/tools/helm"
case "${1:-}" in
  '') server=false ;;
  --server) server=true ;;
  *) echo 'Usage: bash scripts/check-deployment.sh [--server]' >&2; exit 2 ;;
esac
[[ $# -le 1 ]]
[[ -x "$helm" ]] || { echo 'Run bash scripts/prepare-tools.sh first.' >&2; exit 1; }
[[ "$("$helm" version --short)" == v4.3.1* ]]
mkdir -p "$state"
"$helm" lint --strict charts/telegram-pi -f charts/telegram-pi/values-kind.yaml
"$helm" template telegram-pi charts/telegram-pi --namespace telegram-pi \
  -f charts/telegram-pi/values-kind.yaml > "$state/bot.yaml"
"$helm" lint --strict charts/telegram-pi \
  -f charts/telegram-pi/values-kind.yaml -f charts/telegram-pi/values-live.yaml
"$helm" template telegram-pi charts/telegram-pi --namespace telegram-pi \
  -f charts/telegram-pi/values-kind.yaml -f charts/telegram-pi/values-live.yaml \
  > "$state/bot-live.yaml"
npm exec --no -- vitest run tests/deployment.test.ts
k=(kubectl --kubeconfig "$root/.cache/kind/kubeconfig" --context kind-telegram-pi-validation)
"${k[@]}" kustomize deploy/platform > "$state/platform.yaml"
if "$server"; then
  bash scripts/kind-cluster.sh status
  node tests/deployment/vendor-platform.mjs --check
  # The installed exact-pin CRDs and admission policies validate the actual CRs.
  # Server-side dry-run never changes existing objects, even with force-conflicts.
  "${k[@]}" apply --server-side --dry-run=server --force-conflicts \
    --field-manager=telegram-pi-packaging-check -f "$state/platform.yaml" \
    > "$state/platform-server-dryrun.txt"
  "${k[@]}" apply --server-side --dry-run=server --force-conflicts \
    --field-manager=telegram-pi-packaging-check -f "$state/bot.yaml" \
    > "$state/bot-server-dryrun.txt"
  "${k[@]}" apply --server-side --dry-run=server --force-conflicts \
    --field-manager=telegram-pi-packaging-check -f "$state/bot-live.yaml" \
    > "$state/bot-live-server-dryrun.txt"
  echo 'Owned-cluster platform, fixture Bot, and live Bot schema/adoption dry-runs passed.'
fi
echo "Deployment packaging checks passed. Evidence: $state"
