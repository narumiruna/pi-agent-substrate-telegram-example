#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
cluster=telegram-pi-validation
context="kind-$cluster"
registry="$cluster-registry"
port=25071
state="$PWD/.cache/kind"
kind="$PWD/.cache/tools/kind"
kubeconfig="$state/kubeconfig"
node="$cluster-control-plane"

owned_registry() {
  [[ -f "$state/owner" ]] &&
    [[ "$(docker inspect --format '{{index .Config.Labels "telegram-pi-owner"}}' "$registry")" == "$(< "$state/owner")" ]]
}
owned_node() {
  [[ -f "$state/node-id" ]] &&
    [[ "$(docker inspect --format '{{.Id}}' "$node")" == "$(< "$state/node-id")" ]]
}

case "${1:-}" in
  create)
    if docker inspect "$registry" >/dev/null 2>&1 || docker inspect "$node" >/dev/null 2>&1 || [[ -e "$state" ]]; then
      echo "Refusing to replace existing validation resources or state: $state" >&2
      exit 1
    fi
    umask 077
    mkdir -p "$state"
    printf '%s\n' "$(date +%s)-$RANDOM-$RANDOM" > "$state/owner"
    docker run -d --restart=no --name "$registry" \
      --label "telegram-pi-owner=$(< "$state/owner")" \
      -p "127.0.0.1:$port:5000" \
      registry:3@sha256:38907510915c3f1604c7e83d6ab602ab3020d092f73bdaed8696773693ff768c
    "$kind" create cluster --name "$cluster" --kubeconfig "$kubeconfig" \
      --image kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5 \
      --config tests/kind/cluster.yaml --wait 180s || {
        # kind normally removes a failed node. Record any retained node for safe cleanup.
        if docker inspect "$node" >/dev/null 2>&1; then
          docker inspect --format '{{.Id}}' "$node" > "$state/node-id"
        fi
        exit 1
      }
    docker inspect --format '{{.Id}}' "$node" > "$state/node-id"
    docker exec "$node" sysctl net.ipv4.conf.all.proxy_arp=1
    docker exec "$node" mkdir -p "/etc/containerd/certs.d/localhost:$port"
    printf '[host."http://%s:5000"]\n' "$registry" \
      | docker exec -i "$node" cp /dev/stdin "/etc/containerd/certs.d/localhost:$port/hosts.toml"
    docker network connect kind "$registry"
    kubectl --kubeconfig "$kubeconfig" --context "$context" create configmap local-registry-hosting \
      --namespace kube-public --from-literal="localRegistryHosting.v1=host: \"localhost:$port\"
help: \"https://kind.sigs.k8s.io/docs/user/local-registry/\""
    kubectl --kubeconfig "$kubeconfig" --context "$context" wait --for=condition=Ready node --all --timeout=180s
    ;;
  status)
    owned_node
    kubectl --kubeconfig "$kubeconfig" --context "$context" get nodes -o wide
    kubectl --kubeconfig "$kubeconfig" --context "$context" get pods --all-namespaces
    ;;
  delete)
    # Check both identities before changing either resource. Never delete the shared kind network.
    owned_registry
    if [[ -f "$state/node-id" ]]; then
      owned_node
      "$kind" delete cluster --name "$cluster" --kubeconfig "$kubeconfig"
    elif docker inspect "$node" >/dev/null 2>&1; then
      echo 'Refusing to delete an unrecorded validation node.' >&2
      exit 1
    fi
    docker rm -f "$registry"
    rm -rf "$state"
    ;;
  *)
    echo "Usage: bash scripts/kind-cluster.sh {create|status|delete}" >&2
    exit 2
    ;;
esac
