# Isolated Argo CD and application database fixtures

These fixtures prepare task 12. They do not complete task 12. No Application, sync, application migration, Actor workload, or platform restart is part of preparation.

## Fixed target

- Repository: `/home/narumi/src/pi-agent-substrate-telegram-example`.
- Kubeconfig: `/home/narumi/src/pi-agent-substrate-telegram-example/.cache/kind/kubeconfig`.
- Context: `kind-telegram-pi-validation`.
- Registry: `localhost:25071`, container `telegram-pi-validation-registry`.
- The scripts check the saved node ID and registry ownership before cluster access. Each Kubernetes call specifies the kubeconfig and context. They do not use `kind-kind`, `kind-registry`, or host configuration.

## Preparation

Run from the repository root, after the existing isolated platform bootstrap:

```sh
bash scripts/prepare-application-db-kind.sh
bash scripts/prepare-argocd-kind.sh
node --test tests/kind/argocd-bootstrap.test.mjs
```

The scripts need Node.js with the installed `yaml` dependency, Bash, curl, `kubectl`, Docker inspection access, `flock`, and the already verified `.cache/tools/argocd`. They do not install tools or change Docker settings.

The application fixture uses PostgreSQL 18 Alpine at the digest retained in `scripts/test-postgres.sh`. It has its own Deployment, ClusterIP Service, 2 GiB persistent local PVC, and NetworkPolicy in `telegram-pi`. Its namespace, Pod label `app: telegram-pi-postgres`, and port 5432 match `charts/telegram-pi/values-kind.yaml`. Ingress permits only Gateway and migration Pods in that namespace. Database Pods have no Kubernetes API token and no network egress.

- Database `telegram_pi` and schema `public` belong to login `telegram_pi_owner`, which is not a superuser.
- Login `telegram_pi_gateway` is not an owner, superuser, role administrator, or database creator. It initially has only database CONNECT. The chart migration Job must grant its limited runtime access later.
- This instance has no Substrate database or roles. The script never connects to the platform PostgreSQL instance.
- Secrets `telegram-pi-database-owner:url`, `telegram-pi-database-app:url`, and `telegram-bot:BOT_TOKEN` are created in `telegram-pi`. The Bot value is synthetic and fixture-only.
- Secret `telegram-pi-postgres-fixture-admin` stays in the fixture namespace and is mounted only by the database. No chart workload references it. The script does not create Secret-reader RBAC.

Argo CD uses upstream `v3.6.1` **core-install.yaml**, not a Helm chart. `argocd-lock.json` retains the exact source revision, source hash, CLI hash, and resolved container digests. Local rendering changes only ownership labels, image digest pins, namespace placement, and the two documented health keys. The two scoped AppProjects are installed. No Application is installed. All Services remain ClusterIP. There is no deployed Argo API/UI server, Ingress, NodePort, or LoadBalancer.

The Argo script privately reads the current RustFS Deployment credential inputs, resolves Secret references if needed, and creates `ate-system/rustfs-credentials` with exactly those values. It does not change or restart RustFS. A pre-existing unrelated Secret or a value difference stops the script. No RustFS credential value is retained in source.

## Private state and repeat runs

- `.cache/kind/application-postgres/`: generated credentials, ownership marker, rendered private Secret inputs, installed resource evidence, checks, and source hashes.
- `.cache/kind/argocd-bootstrap/`: original upstream manifest, lock copy, rendered installation, source hashes, CLI evidence, public repository access check, and private RustFS inputs.
- Private directories are mode 0700. Credential files and private inputs are mode 0600. Do not print or commit them.
- Resource preflight checks the full intended object set before writes. Existing objects must match the saved random ownership label. Secrets must also match exactly. Neither script forces field ownership conflicts.
- Repeat preparation preserves database storage and credentials. It does not run initialization again against an initialized PVC. Losing private state requires manual recovery; do not delete a PVC to bypass a refusal.
- Argo preparation stops if an Application or ApplicationSet exists. After the commit gate, use the normal read-only CLI and explicit sync commands, not the preparation script.

Checks are in each state directory's `checks.txt` and `SHA256SUMS`. Retain these directories until the validation is complete. No automatic cleanup is supplied for persistent data.

## Read-only core CLI

The Argo preparation script sets only the isolated context's namespace to `argocd` in the authorized kubeconfig. It does not change the default host kubeconfig. Use a clean environment to avoid inherited Argo server credentials:

```bash
cd /home/narumi/src/pi-agent-substrate-telegram-example
state="$PWD/.cache/kind/argocd-bootstrap"
k=(kubectl --kubeconfig "$PWD/.cache/kind/kubeconfig" --context kind-telegram-pi-validation)
a() {
  env -i HOME="$state/home" PATH="$PATH" XDG_CONFIG_HOME="$state/xdg" \
    KUBECONFIG="$PWD/.cache/kind/kubeconfig" \
    timeout 300 "$PWD/.cache/tools/argocd" --core \
    --kube-context kind-telegram-pi-validation --config "$state/cli-config" \
    --prompts-enabled=false "$@"
}
a app list --app-namespace argocd
"${k[@]}" -n argocd get pods,services,appprojects,applications,applicationsets
```

Core mode uses the verified Kubernetes API connection and a temporary loopback CLI API process. No `--insecure`, TLS-verification bypass, public endpoint, or remote Argo login is needed.

## Closed commit gate: reference commands only

**Do not run this section until the main agent explicitly approves the exact committed and public revision.** Preparation does not supply that approval. Do not substitute a branch or a local uncommitted tree. The actual Gateway image digest, chart/server checks, platform bootstrap prerequisites, and main agent's retained-state baseline must also pass first.

With the shell functions above, use the exact 40-character approved commit in place of the marker:

```bash
set -euo pipefail
umask 077
APPROVED_COMMIT=REPLACE_WITH_MAIN_APPROVED_40_CHARACTER_COMMIT
[[ "$APPROVED_COMMIT" =~ ^[0-9a-f]{40}$ ]]
git cat-file -e "$APPROVED_COMMIT^{commit}"
git diff --exit-code "$APPROVED_COMMIT" -- deploy/argocd deploy/platform charts/telegram-pi
curl --fail --silent --show-error --location \
  "https://raw.githubusercontent.com/narumiruna/pi-agent-substrate-telegram-example/$APPROVED_COMMIT/deploy/argocd/applications.yaml" \
  -o "$state/applications-public-source.yaml"
cmp deploy/argocd/applications.yaml "$state/applications-public-source.yaml"
node --input-type=module - "$APPROVED_COMMIT" "$state" <<'JS'
import fs from 'node:fs';
const [revision, state] = process.argv.slice(2);
const source = fs.readFileSync('deploy/argocd/applications.yaml', 'utf8');
if ((source.match(/REPLACE_WITH_REVIEWED_PACKAGING_COMMIT/g) ?? []).length !== 2) {
  throw Error('Expected exactly two explicit revision markers');
}
fs.writeFileSync(`${state}/applications-approved.yaml`,
  source.replaceAll('REPLACE_WITH_REVIEWED_PACKAGING_COMMIT', revision), {mode: 0o600});
JS
"${k[@]}" apply --server-side --field-manager=telegram-pi-reviewed-applications \
  -f "$state/applications-approved.yaml"
a app sync substrate-platform --timeout 300
a app wait substrate-platform --sync --health --timeout 300
# Fixture HTTPS target port 8443 is required by the enforcing local CNI.
"${k[@]}" apply -f tests/deployment/kind-fixture-network.yaml
a app sync telegram-pi --timeout 300
a app wait telegram-pi --sync --health --timeout 300
a app get substrate-platform -o json > "$state/platform-first-sync.json"
a app get telegram-pi -o json > "$state/bot-first-sync.json"
```

Do not add prune, force, replace, automated sync, or a deletion finalizer. A first sync is not task 12 evidence by itself. The main agent must run the planned workload checks, retain state comparisons, and reconcile the same approved revision again. This preparation does not run those checks.
