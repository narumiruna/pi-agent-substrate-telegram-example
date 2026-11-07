#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
bash scripts/kind-cluster.sh status
k=(kubectl --kubeconfig "$PWD/.cache/kind/kubeconfig" --context kind-telegram-pi-validation)
namespace=telegram-pi-policy-check
image=busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
uid="$("${k[@]}" create namespace "$namespace" -o jsonpath='{.metadata.uid}')"
cleanup() {
  if [[ "$("${k[@]}" get namespace "$namespace" -o jsonpath='{.metadata.uid}')" == "$uid" ]]; then
    "${k[@]}" delete namespace "$namespace" --wait=true --timeout=90s
  else
    echo 'Refusing to remove a replaced policy-test namespace.' >&2
  fi
}
trap cleanup EXIT
k+=(--namespace "$namespace")
"${k[@]}" run server --image="$image" --restart=Never --labels=role=server \
  --command -- sh -c 'mkdir /www; printf "fixture-only-policy-ok\n" > /www/index.html; exec httpd -f -p 8080 -h /www'
for role in allowed denied; do
  "${k[@]}" run "$role" --image="$image" --restart=Never --labels="role=$role" \
    --command -- sleep 600
done
"${k[@]}" wait --for=condition=Ready pod --all --timeout=180s
ip="$("${k[@]}" get pod server -o jsonpath='{.status.podIP}')"
fetch() {
  "${k[@]}" exec "$1" -- wget -q -T 3 -O - "http://$ip:8080/"
}
[[ "$(fetch allowed)" == fixture-only-policy-ok ]]
[[ "$(fetch denied)" == fixture-only-policy-ok ]]
echo 'Baseline: both clients can reach the fixture.'
"${k[@]}" apply -f tests/kind/allow-policy-client.yaml
# Policy propagation is asynchronous. Require a failed new TCP connection,
# with successful control requests before and after it, rather than just Ready.
denied=false
for attempt in {1..15}; do
  [[ "$(fetch allowed)" == fixture-only-policy-ok ]]
  if ! fetch denied; then
    denied=true
    break
  fi
  sleep 1
done
[[ "$denied" == true ]]
[[ "$(fetch allowed)" == fixture-only-policy-ok ]]
echo 'NetworkPolicy: allowed client succeeds; denied client cannot connect.'
