#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
state="$root/.cache/kind"
kubeconfig="$state/kubeconfig"
context=kind-telegram-pi-validation
namespace=telegram-pi-fixtures
registry=telegram-pi-validation-registry
image_tag=localhost:25071/telegram-pi-fixture:synthetic
expected_envoy=localhost:25071/envoy-dataplane@sha256:aee088bdf94873fa2100a5512dde843119740dbbf5cba6187341c1f8d936528d
k=(kubectl --kubeconfig "$kubeconfig" --context "$context")

# Fixed ownership checks. No ambient context, registry, namespace, or image override.
check_owned() {
  [[ -f "$state/node-id" && -f "$state/owner" && -f "$kubeconfig" ]]
  [[ "$(docker inspect --format '{{.Id}}' telegram-pi-validation-control-plane)" == "$(< "$state/node-id")" ]]
  [[ "$(docker inspect --format '{{index .Config.Labels "telegram-pi-owner"}}' "$registry")" == "$(< "$state/owner")" ]]
}

case "${1:-}" in
  unit)
    node --test tests/fixtures/check.mjs
    ;;
  build)
    check_owned
    mkdir -p "$state/fixtures"
    docker build --platform=linux/amd64 --network=none \
      --file tests/fixtures/Dockerfile --tag "$image_tag" tests/fixtures
    docker push "$image_tag"
    image="$(docker image inspect "$image_tag" --format '{{index .RepoDigests 0}}')"
    [[ "$image" =~ ^localhost:25071/telegram-pi-fixture@sha256:[0-9a-f]{64}$ ]]
    printf '%s\n' "$image" > "$state/fixtures/image"
    printf 'Fixture image: %s\n' "$image"
    ;;
  deploy)
    check_owned
    image="$(< "$state/fixtures/image")"
    [[ "$image" =~ ^localhost:25071/telegram-pi-fixture@sha256:[0-9a-f]{64}$ ]]
    actual_envoy="$("${k[@]}" --namespace ate-system get deployment atenet-egress -o jsonpath='{.spec.template.spec.containers[?(@.name=="envoy")].image}')"
    [[ "$actual_envoy" == "$expected_envoy" ]] || { echo 'Refusing fixture trust patch on an unrecognized Envoy image.' >&2; exit 1; }
    [[ "$("${k[@]}" --namespace ate-system get deployment atenet-egress -o jsonpath='{.spec.template.spec.initContainers[?(@.name=="sdsmint")].name}')" == sdsmint ]]
    node --input-type=module -e '
      import {readFileSync} from "node:fs";
      console.log(readFileSync("tests/fixtures/kind.yaml", "utf8").replaceAll("FIXTURE_IMAGE", process.argv[1]));
    ' "$image" > "$state/fixtures/kind.yaml"
    "${k[@]}" apply -f "$state/fixtures/kind.yaml"
    "${k[@]}" --namespace "$namespace" rollout status deployment/synthetic-api --timeout=120s
    "${k[@]}" --namespace ate-system patch deployment atenet-egress --type=strategic \
      --patch-file tests/fixtures/egress-upstream-roots.patch.yaml
    "${k[@]}" --namespace ate-system rollout status deployment/atenet-egress --timeout=120s
    ;;
  check)
    check_owned
    "${k[@]}" --namespace "$namespace" exec deployment/synthetic-api -- node /fixture/cluster-check.mjs
    ;;
  *)
    echo 'Usage: bash scripts/kind-fixtures.sh {unit|build|deploy|check}' >&2
    exit 2
    ;;
esac
