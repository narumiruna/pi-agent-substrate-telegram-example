#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
bash scripts/kind-cluster.sh status
manifest="$PWD/.cache/kind/calico-policy-only.yaml"
curl --fail --silent --show-error --location --retry 2 \
  https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/calico-policy-only.yaml \
  -o "$manifest"
printf '%s  %s\n' \
  e9cf6a25545cf0e9ad1175bd383e0d661d5a0f09efc5f212d22ee66795f046e1 "$manifest" \
  | sha256sum --check
# Single-node host-local networking and Calico policy; no BGP or host-wide sysctls.
kubectl --kubeconfig .cache/kind/kubeconfig --context kind-telegram-pi-validation \
  apply --server-side -f "$manifest"
kubectl --kubeconfig .cache/kind/kubeconfig --context kind-telegram-pi-validation \
  apply -f tests/kind/calico-cni-rbac.yaml
kubectl --kubeconfig .cache/kind/kubeconfig --context kind-telegram-pi-validation \
  --namespace kube-system rollout status daemonset/calico-node --timeout=180s
kubectl --kubeconfig .cache/kind/kubeconfig --context kind-telegram-pi-validation \
  --namespace kube-system rollout status deployment/calico-kube-controllers --timeout=180s
