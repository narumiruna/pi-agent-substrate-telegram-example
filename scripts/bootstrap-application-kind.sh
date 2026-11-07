#!/usr/bin/env bash
# Operator-only bootstrap for disposable application atespaces and fixture secrets.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
root="$PWD"
bash scripts/kind-cluster.sh status
k=(kubectl --kubeconfig "$root/.cache/kind/kubeconfig" --context kind-telegram-pi-validation)
state="$root/.cache/kind/application-bootstrap"
mkdir -p "$state"
"${k[@]}" --namespace ate-system create token substrate-bootstrap \
  --audience=api.ate-system.svc --duration=1h > "$state/operator-token"
chmod 600 "$state/operator-token"
ate() {
  env -i HOME="$HOME" PATH="$PATH" timeout 120 "$root/.cache/tools/kubectl-ate" \
    --context=kind-telegram-pi-validation --kubeconfig="$root/.cache/kind/kubeconfig" \
    --token-file="$state/operator-token" "$@"
}
"${k[@]}" apply -f tests/kind/application-identities.yaml
for atespace in telegram-pi-actor-validation telegram-pi; do
  if ! ate create atespace "$atespace" > "$state/$atespace.txt" 2> "$state/$atespace.err"; then
    grep -q AlreadyExists "$state/$atespace.err"
    ate get atespace "$atespace" > "$state/$atespace.txt"
  fi
  if ! ate create access-policy -a "$atespace" -f tests/kind/application-access-policy.json \
    -o json > "$state/$atespace-create.json" 2> "$state/$atespace-create.err"; then
    grep -q AlreadyExists "$state/$atespace-create.err"
  fi
  ate get access-policy -a "$atespace" -o json > "$state/$atespace-policy.json"
  node --input-type=module - tests/kind/application-access-policy.json "$state/$atespace-policy.json" <<'JS'
import { readFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
const [expected, actual] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path)))
if (!isDeepStrictEqual(expected.bindings, actual.bindings)) throw new Error("Existing grants differ")
JS
done
"${k[@]}" apply -f tests/kind/actor-credential-provider.yaml
# Remove the upstream demonstration's cluster-wide Secret read binding. Keep
# only the one-Secret namespaced Role above. Never add application API owners.
if "${k[@]}" get clusterrolebinding k8s-credential-provider-secret-reader >/dev/null 2>&1; then
  binding="$("${k[@]}" get clusterrolebinding k8s-credential-provider-secret-reader \
    -o jsonpath='{.roleRef.name}:{.subjects[0].namespace}:{.subjects[0].name}')"
  [[ "$binding" == k8s-credential-provider-secret-reader:ate-system:k8s-credential-provider ]]
  "${k[@]}" delete clusterrolebinding k8s-credential-provider-secret-reader
fi
"${k[@]}" --namespace ate-system rollout restart deployment/k8s-credential-provider
"${k[@]}" --namespace ate-system rollout status deployment/k8s-credential-provider --timeout=180s
principal=system:serviceaccount:ate-system:k8s-credential-provider
[[ "$("${k[@]}" auth can-i get secret/openai-fixture -n telegram-pi-llm --as="$principal")" == yes ]]
[[ "$("${k[@]}" auth can-i get secret/other-secret -n telegram-pi-llm --as="$principal" || true)" == no ]]
[[ "$("${k[@]}" auth can-i get secret/telegram-bot -n telegram-pi --as="$principal" || true)" == no ]]
echo 'Application API grants and one-Secret credential-provider access are ready.'
