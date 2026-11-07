#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
state="$root/.cache/kind"
source="$root/.cache/substrate"
revision=94e0a26ac90151886a76410568aaac2664a54d90
context=kind-telegram-pi-validation
kubeconfig="$state/kubeconfig"

# This boundary is a local installer, not a fully declarative platform chart.
# It generates CAs only when absent. It must never run against another cluster.
bash scripts/kind-cluster.sh status
if [[ ! -d "$source/.git" ]]; then
  git clone --no-checkout https://github.com/agent-substrate/substrate.git "$source"
  git -C "$source" checkout --detach "$revision"
fi
[[ "$(git -C "$source" rev-parse HEAD)" == "$revision" ]]
patch="$root/deploy/platform/kind-registry.patch"
if git -C "$source" diff --quiet; then
  git -C "$source" apply "$patch"
fi
# Refuse unknown tracked or untracked source edits, including staged changes.
[[ "$(git -C "$source" status --porcelain --untracked-files=all)" == \
  ' M manifests/ate-install/kind/atelet/kustomization.yaml' ]]
printf '%s  %s\n' \
  5e8ce821431d0bb7e44d2f79ecd71bcc9792a68230be6804400275a1dbfb5363 \
  "$source/manifests/ate-install/kind/atelet/kustomization.yaml" | sha256sum --check

kubectl --kubeconfig "$kubeconfig" --context "$context" create namespace ate-system \
  --dry-run=client -o yaml | kubectl --kubeconfig "$kubeconfig" --context "$context" apply -f -
kubectl --kubeconfig "$kubeconfig" --context "$context" --namespace ate-system \
  create serviceaccount substrate-bootstrap --dry-run=client -o yaml \
  | kubectl --kubeconfig "$kubeconfig" --context "$context" apply -f -

cd "$source"
# Exclude ambient ATE_CONFIG, external database credentials, cloud settings, and
# developer shell files. All images are built locally from the selected source.
env -i HOME="$HOME" PATH="$PATH" XDG_CACHE_HOME="$state/cache" \
  go run ./cmd/ate-setup \
  --kind --kind-cluster-name=telegram-pi-validation \
  --context="$context" --kubeconfig="$kubeconfig" --no-dev-env \
  --namespace=ate-system --atenet-dataplane=envoy \
  --ko-docker-repo=localhost:25071 --ko-default-platforms=linux/amd64 \
  --storage-bucket-name=ate-snapshots --snapshot-location=gs://ate-snapshots/ \
  --ateapi-authz-bootstrap-owners=system:serviceaccount:ate-system:substrate-bootstrap \
  --ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/telegram-pi/sa/gateway \
  --credential-provider='{"name":"k8s.io"}' --preview='' \
  --record-dir="$state/install-records" --rollout-timeout=180s \
  deploy ate-system --sandbox-classes=gvisor --setup-csi=none

kubectl --kubeconfig "$kubeconfig" --context "$context" --namespace ate-system \
  wait --for=condition=complete job/rustfs-bucket-init --timeout=180s
