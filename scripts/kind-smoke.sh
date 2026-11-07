#!/usr/bin/env bash
# Platform prerequisite only. No application code or real external credentials.
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
root="$PWD"
source="$root/.cache/substrate"
state="$root/.cache/kind/smoke"
context=kind-telegram-pi-validation
kubeconfig="$root/.cache/kind/kubeconfig"
revision=94e0a26ac90151886a76410568aaac2664a54d90
atespace=telegram-pi-platform-smoke
mkdir -p "$state" "$root/.cache/tools"
for tool in kubectl go node envsubst git timeout; do
  command -v "$tool" >/dev/null
done
k() { kubectl --context="$context" --kubeconfig="$kubeconfig" "$@"; }
ate() {
  env -i HOME="$HOME" PATH="$PATH" timeout 120 "$root/.cache/tools/kubectl-ate" \
    --context="$context" --kubeconfig="$kubeconfig" \
    --token-file="$state/operator-token" "$@"
}

# Never discover a target from the ambient kubeconfig or installer settings.
[[ "$kubeconfig" = /* && -f "$kubeconfig" ]]
[[ "$(git -C "$source" rev-parse HEAD)" == "$revision" ]]
git -C "$source" diff --exit-code -- . ':!manifests/ate-install/kind/atelet/kustomization.yaml'
[[ -z "$(git -C "$source" ls-files --others --exclude-standard)" ]]
printf '%s  %s\n' \
  5e8ce821431d0bb7e44d2f79ecd71bcc9792a68230be6804400275a1dbfb5363 \
  "$source/manifests/ate-install/kind/atelet/kustomization.yaml" | sha256sum --check
[[ "$(k get nodes -o jsonpath='{.items[*].metadata.name}')" == telegram-pi-validation-control-plane ]]
k -n ate-system wait --for=condition=complete job/rustfs-bucket-init --timeout=180s
k -n ate-system rollout status deployment/ate-api-server --timeout=180s
k -n ate-system rollout status daemonset/atelet --timeout=180s

# Build ko from its pinned module, then execute it from the source root so it
# uses the exact-pin .ko.yaml, Go module, bases, and embedded sandbox flags.
(
  cd "$source/hack/tools/ko"
  env -i HOME="$HOME" PATH="$PATH" XDG_CACHE_HOME="$root/.cache/kind/cache" \
    go build -o "$root/.cache/tools/ko" github.com/google/ko
  cd "$source"
  env -i HOME="$HOME" PATH="$PATH" XDG_CACHE_HOME="$root/.cache/kind/cache" \
    go build -o "$root/.cache/tools/kubectl-ate" ./cmd/kubectl-ate
  env -i HOME="$HOME" PATH="$PATH" XDG_CACHE_HOME="$root/.cache/kind/cache" \
    KO_DOCKER_REPO=localhost:25071 "$root/.cache/tools/ko" build \
    --platform=linux/amd64 ./cmd/ateworker-gvisor ./demos/counter
) >"$state/images.txt" 2>"$state/image-build.log"
WORKER_IMAGE="$(grep '/ateworker-gvisor-.*@sha256:' "$state/images.txt")"
COUNTER_IMAGE="$(grep '/counter-.*@sha256:' "$state/images.txt")"
[[ "$WORKER_IMAGE" =~ ^localhost:25071/[^[:space:]]+@sha256:[a-f0-9]{64}$ ]]
[[ "$COUNTER_IMAGE" =~ ^localhost:25071/[^[:space:]]+@sha256:[a-f0-9]{64}$ ]]
export WORKER_IMAGE COUNTER_IMAGE
envsubst <tests/kind/platform-workerpool.yaml.tmpl >"$state/workerpool.yaml"
envsubst <tests/kind/platform-template.json.tmpl >"$state/template-desired.json"
k apply -f "$state/workerpool.yaml"
k -n telegram-pi rollout status deployment/platform-smoke --timeout=180s

# Keep the bootstrap bearer token on disk only. The CLI's default ate-client
# principal is not the configured owner. No bootstrap token enters a Pod.
k -n ate-system create token substrate-bootstrap --audience=api.ate-system.svc \
  --duration=1h >"$state/operator-token"
chmod 600 "$state/operator-token"
if ! ate create atespace "$atespace" >"$state/atespace.txt" 2>"$state/atespace.err"; then
  grep -q 'AlreadyExists' "$state/atespace.err"
  ate get atespace "$atespace" >"$state/atespace.txt"
fi
if ! ate create actor-template -f "$state/template-desired.json" -o json \
  >"$state/template-create.json" 2>"$state/template-create.err"; then
  grep -q 'AlreadyExists' "$state/template-create.err"
fi
ate get actor-template counter-94e0a26a -a "$atespace" -o json >"$state/template.json"
# Compare the full caller-owned template, not only its image or name.
node --input-type=module - "$state/template-desired.json" "$state/template.json" <<'JS'
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
const [desired, actual] = process.argv.slice(2).map(p => JSON.parse(readFileSync(p)));
for (const object of [desired, actual]) {
  object.metadata = {atespace: object.metadata.atespace, name: object.metadata.name};
  delete object.status;
}
if (!isDeepStrictEqual(desired, actual)) throw new Error('Existing template spec differs');
JS
for ((attempt=0; attempt<90; attempt++)); do
  ate get actor-template counter-94e0a26a -a "$atespace" -o json >"$state/template.json"
  result="$(node --input-type=module - "$state/template.json" <<'JS'
import {readFileSync} from 'node:fs';
const s = JSON.parse(readFileSync(process.argv[2])).status?.goldenSnapshotStatus ?? {};
if (s.errorMessage) throw new Error(s.errorMessage);
console.log(s.goldenTag?.name ?? '');
JS
)"
  [[ -n "$result" ]] && break
  sleep 2
done
[[ -n "$result" ]]
ate get tag "$result" -a "$atespace" -o json >"$state/golden-tag.json"
node --input-type=module - "$state/golden-tag.json" <<'JS'
import {readFileSync} from 'node:fs';
const s = JSON.parse(readFileSync(process.argv[2])).status?.snapshot;
if (s?.durableSnapshot?.state !== 'SNAPSHOT_STORAGE_STATE_COMPLETED' ||
    !s.durableSnapshot.object?.snapshotUri || s.sandboxRuntime?.sandboxClass !== 'gvisor') {
  throw new Error('Golden snapshot is not durably completed under gVisor');
}
console.log('Golden snapshot fidelity:', s.fidelity);
JS
if ! ate create actor counter-smoke --template=counter-94e0a26a -a "$atespace" -o json \
  >"$state/actor-create.json" 2>"$state/actor-create.err"; then
  grep -q 'AlreadyExists' "$state/actor-create.err"
fi
ate get actor counter-smoke -a "$atespace" -o json >"$state/actor.json"
node --input-type=module - "$state/actor.json" <<'JS'
import {readFileSync} from 'node:fs';
const a = JSON.parse(readFileSync(process.argv[2]));
if (a.actorTemplate?.atespace !== 'telegram-pi-platform-smoke' ||
    a.actorTemplate?.name !== 'counter-94e0a26a' || a.workerSelector || a.sourceTag) {
  throw new Error('Existing Actor specification differs');
}
JS
printf 'rules: []\n' >"$state/egress-desired.yaml"
if ! ate create egress-policy counter-smoke -a "$atespace" -f "$state/egress-desired.yaml" -o json \
  >"$state/egress-create.json" 2>"$state/egress-create.err"; then
  grep -q 'AlreadyExists' "$state/egress-create.err"
fi
ate get egress-policy counter-smoke -a "$atespace" -o json >"$state/egress-policy.json"
node --input-type=module - "$state/egress-policy.json" <<'JS'
import {readFileSync} from 'node:fs';
if (JSON.parse(readFileSync(process.argv[2])).rules?.length) throw new Error('Expected deny-all egress');
JS

# Re-run only this harness-owned disposable bucket Job. The additional policy
# admits only its labeled Pods to RustFS; no platform or application impersonation.
k -n ate-system delete job platform-smoke-bucket --ignore-not-found --wait=true
k apply -f tests/kind/platform-bucket.yaml
k -n ate-system wait --for=condition=complete job/platform-smoke-bucket --timeout=150s
k -n ate-system logs job/platform-smoke-bucket >"$state/bucket.log"
k -n ate-system exec postgres-0 -c postgres -- psql -U postgres -d atepg -Atc \
  'SELECT version_id, is_applied FROM substrate.schema_migrations ORDER BY id;' >"$state/migrations.txt"
grep -qx '1|t' "$state/migrations.txt"

k apply -f tests/kind/platform-gateway.yaml
k -n telegram-pi wait --for=condition=ready pod/platform-router-probe --timeout=120s
router() {
  k -n telegram-pi exec platform-router-probe -- curl --fail --silent --show-error \
    --max-time 90 --cacert /var/run/ate/ca.crt \
    --cert /var/run/ate/credential-bundle.pem --key /var/run/ate/credential-bundle.pem \
    -H "ate-target-actor: $atespace/counter-smoke" https://atenet-router.ate-system.svc/
}
router >"$state/router-before.txt"
ate get actor counter-smoke -a "$atespace" -o json >"$state/actor-running.json"
ate suspend actor counter-smoke -a "$atespace" --mode=sync -o json >"$state/suspend.json"
node --input-type=module - "$state/actor-running.json" "$state/suspend.json" <<'JS'
import {readFileSync} from 'node:fs';
const [before, after] = process.argv.slice(2).map(p => JSON.parse(readFileSync(p)));
const s = after.status;
const latest = s.snapshots?.find(x => x.generation === s.lastAssignedGeneration);
if (before.status.state !== 'ACTOR_STATE_RUNNING' || before.metadata.uid !== after.metadata.uid ||
    s.state !== 'ACTOR_STATE_SUSPENDED' || !latest?.uuid ||
    latest.durableSnapshot?.state !== 'SNAPSHOT_STORAGE_STATE_COMPLETED' ||
    !latest.durableSnapshot.object?.snapshotUri || latest.sandboxRuntime?.sandboxClass !== 'gvisor') {
  throw new Error('Latest synchronous checkpoint receipt is incomplete');
}
console.log('Actor checkpoint fidelity:', latest.fidelity, 'generation:', latest.generation);
JS
# A failed TLS handshake must not resume the suspended Actor.
if k -n telegram-pi exec platform-router-probe -- curl --fail --silent --show-error \
  --max-time 10 --cacert /var/run/ate/ca.crt -H "ate-target-actor: $atespace/counter-smoke" \
  https://atenet-router.ate-system.svc/ >"$state/router-missing-cert.txt" 2>"$state/router-missing-cert.err"; then
  echo 'Router admitted a client without its certificate' >&2
  exit 1
fi
ate get actor counter-smoke -a "$atespace" -o json >"$state/actor-after-denial.json"
node --input-type=module - "$state/suspend.json" "$state/actor-after-denial.json" <<'JS'
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
const [before, after] = process.argv.slice(2).map(p => JSON.parse(readFileSync(p)));
if (!isDeepStrictEqual(before, after)) throw new Error('Denied request changed Actor state');
JS
router >"$state/router-after.txt"
node --input-type=module - "$state/router-before.txt" "$state/router-after.txt" <<'JS'
import {readFileSync} from 'node:fs';
const counts = process.argv.slice(2).map(p => {
  const text = readFileSync(p, 'utf8');
  const match = /^preserved memory count: (\d+) \| preserved file counter: (\d+) \| preserved rootfs counter: (\d+)\n$/.exec(text);
  if (!match) throw new Error('Invalid counter response: ' + text);
  return match.slice(1).map(Number);
});
if (counts[1].some((v, i) => v !== counts[0][i] + 1)) throw new Error('Counter state did not survive memory resume');
console.log('Router mTLS and memory/file/rootfs continuation passed:', counts);
JS
# End suspended with the newest complete remote receipt. Locality is retained:
# this test does not claim a remote-only restore, Pi storage, or CNI enforcement.
ate suspend actor counter-smoke -a "$atespace" --mode=sync -o json >"$state/final-suspend.json"
ate get workers -o json >"$state/workers.json"
k -n telegram-pi get workerpool platform-smoke -o json >"$state/workerpool.json"
k -n telegram-pi get pods -o json >"$state/pods.json"
k get clustertrustbundles -o json >"$state/trust-bundles.json"
k -n ate-system get pods -o json >"$state/platform-pods.json"
k -n podcertificate-controller-system get pods -o json >"$state/signer-pods.json"
k -n ate-system logs deployment/ate-api-server -c ate-api-server >"$state/api.log"
grep -q 'PostgreSQL migrations ready' "$state/api.log"
k -n ate-system logs daemonset/atelet -c atelet >"$state/atelet.log"
node --input-type=module - "$state/workers.json" "$state/pods.json" "$state/final-suspend.json" <<'JS'
import {readFileSync} from 'node:fs';
const [result, pods, actor] = process.argv.slice(2).map(p => JSON.parse(readFileSync(p)));
const workers = result.workers.filter(w => w.workerNamespace === 'telegram-pi' && w.workerPool === 'platform-smoke');
if (workers.length !== 2 || workers.some(w => w.status.state !== 'WORKER_STATE_ACTIVE' ||
    !w.status.sandboxClasses?.some(s => s.sandboxClass === 'gvisor' && s.defaultRuntime))) {
  throw new Error('Expected two active gVisor workers with advertised runtimes');
}
for (const worker of workers) {
  const pod = pods.items.find(p => p.metadata.uid === worker.workerPodUid);
  if (!pod || [...pod.spec.containers, ...(pod.spec.initContainers ?? [])]
      .some(c => c.securityContext?.privileged === true)) throw new Error('Unsafe worker Pod');
}
const latest = actor.status.snapshots.find(s => s.generation === actor.status.lastAssignedGeneration);
if (actor.status.state !== 'ACTOR_STATE_SUSPENDED' || !latest?.uuid ||
    latest.durableSnapshot?.state !== 'SNAPSHOT_STORAGE_STATE_COMPLETED' ||
    !latest.durableSnapshot.object?.snapshotUri) throw new Error('Incomplete final checkpoint');
JS
while IFS= read -r pod; do
  k -n telegram-pi logs "$pod" >"$state/${pod#pod/}.log"
done < <(k -n telegram-pi get pods -l ate.dev/worker-pool=platform-smoke -o name)

# Downstream identity fixtures get atespace editor only after the platform gate.
# Never replace an existing policy, grant the ungranted SA, or alter Router IDs.
k apply -f tests/kind/platform-identities.yaml
if ! ate create access-policy -a "$atespace" -f tests/kind/platform-access-policy.json -o json \
  >"$state/access-policy-create.json" 2>"$state/access-policy-create.err"; then
  grep -q 'AlreadyExists' "$state/access-policy-create.err"
fi
ate get access-policy -a "$atespace" -o json >"$state/access-policy.json"
node --input-type=module - tests/kind/platform-access-policy.json "$state/access-policy.json" <<'JS'
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
const [expected, actual] = process.argv.slice(2).map(p => JSON.parse(readFileSync(p)));
if (!isDeepStrictEqual(expected.bindings, actual.bindings)) throw new Error('Existing atespace grants differ');
JS
printf 'Platform smoke passed. Evidence: %s\n' "$state"
