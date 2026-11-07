#!/usr/bin/env bash
# Persistent application fixture only; never connect to the Substrate database.
set +x
set -euo pipefail
umask 077
cd "$(dirname "${BASH_SOURCE[0]}")/.."
root="$PWD"
expected=/home/narumi/src/pi-agent-substrate-telegram-example
[[ "$root" == "$expected" ]] || { echo 'Refuse a different repository path.' >&2; exit 1; }
[[ $# == 0 ]] || { echo 'Usage: bash scripts/prepare-application-db-kind.sh' >&2; exit 2; }
kubeconfig="$root/.cache/kind/kubeconfig"
context=kind-telegram-pi-validation
k=(kubectl --kubeconfig "$kubeconfig" --context "$context")
[[ -f .cache/kind/node-id && -f .cache/kind/owner && -f "$kubeconfig" ]]
[[ "$(docker inspect --format '{{.Id}}' telegram-pi-validation-control-plane)" == "$(< .cache/kind/node-id)" ]]
[[ "$(docker inspect --format '{{index .Config.Labels "telegram-pi-owner"}}' telegram-pi-validation-registry)" == "$(< .cache/kind/owner)" ]]
"${k[@]}" get node telegram-pi-validation-control-plane -o name >/dev/null
state="$root/.cache/kind/application-postgres"
mkdir -p "$state"
chmod 700 "$state"
exec 9>"$state/lock"
flock -n 9 || { echo 'Application fixture preparation is already running.' >&2; exit 1; }

# No Secret is adopted, overwritten, printed, or rotated. Losing this directory
# requires manual recovery, not generation of replacement credentials for a PVC.
node --input-type=module - "$state" <<'JS'
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {parseAllDocuments} from 'yaml';
const state=process.argv[2];
const privateFile=(p)=>{const s=fs.lstatSync(p); if(!s.isFile() || (s.mode & 0o077)) throw Error('Unsafe private fixture file permissions');};
const ownerPath=`${state}/owner`;
if(!fs.existsSync(ownerPath)) fs.writeFileSync(ownerPath,randomBytes(16).toString('hex'),{mode:0o600,flag:'wx'});
privateFile(ownerPath);
const owner=fs.readFileSync(ownerPath,'utf8').trim();
if(!/^[a-f0-9]{32}$/.test(owner)) throw Error('Invalid fixture ownership record');
const credsPath=`${state}/credentials.json`;
if(!fs.existsSync(credsPath)) fs.writeFileSync(credsPath,JSON.stringify({admin:randomBytes(32).toString('hex'),owner:randomBytes(32).toString('hex'),app:randomBytes(32).toString('hex')}),{mode:0o600,flag:'wx'});
privateFile(credsPath);
let creds;
try { creds=JSON.parse(fs.readFileSync(credsPath)); } catch { throw Error('Invalid private fixture credentials'); }
if(!['admin','owner','app'].every(k=>/^[a-f0-9]{64}$/.test(creds[k]))) throw Error('Invalid private fixture credentials');
const label={'telegram-pi.dev/fixture-owner':owner};
const secret=(name,stringData)=>({apiVersion:'v1',kind:'Secret',metadata:{name,namespace:'telegram-pi',labels:label},type:'Opaque',data:Object.fromEntries(Object.entries(stringData).map(([k,v])=>[k,Buffer.from(v).toString('base64')]))});
const host='telegram-pi-postgres.telegram-pi.svc:5432/telegram_pi';
const docs=[
 secret('telegram-pi-postgres-fixture-admin',{'admin-password':creds.admin,'owner-password':creds.owner,'app-password':creds.app}),
 secret('telegram-pi-database-owner',{url:`postgresql://telegram_pi_owner:${creds.owner}@${host}`}),
 secret('telegram-pi-database-app',{url:`postgresql://telegram_pi_gateway:${creds.app}@${host}`}),
 secret('telegram-bot',{BOT_TOKEN:'900001:fixture-only'}),
 ...parseAllDocuments(fs.readFileSync('tests/kind/application-postgres.yaml','utf8')).map(d=>d.toJS())
];
for(const d of docs){
 d.metadata.labels={...d.metadata.labels,...label};
 d.metadata.annotations={...d.metadata.annotations,'argocd.argoproj.io/sync-options':'Prune=false,Delete=false'};
 if(d.spec?.template) d.spec.template.metadata.labels={...d.spec.template.metadata.labels,...label};
}
fs.writeFileSync(`${state}/resources.private.json`,JSON.stringify({apiVersion:'v1',kind:'List',items:docs}),{mode:0o600});
JS
# Preflight the entire set before the first write. Do not change the pre-existing
# telegram-pi namespace, its labels, grants, policies, workers, or workloads.
node --input-type=module - "$state" "$kubeconfig" "$context" <<'JS'
import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const [state,kubeconfig,context]=process.argv.slice(2);
const call=(args)=>{const r=spawnSync('kubectl',['--kubeconfig',kubeconfig,'--context',context,...args],{encoding:'utf8'}); if(r.status!==0) throw Error('Kubernetes fixture preflight failed'); return r.stdout.trim();};
const ns=call(['get','namespace','telegram-pi','-o','json']);
if(JSON.parse(ns).metadata.labels?.['ate.dev/api-access']!=='true') throw Error('Application namespace prerequisite is missing');
const docs=JSON.parse(fs.readFileSync(`${state}/resources.private.json`)).items;
for(const d of docs){
 const raw=call(['get',d.kind,d.metadata.name,'-n','telegram-pi','--ignore-not-found','-o','json']);
 if(!raw) continue;
 const actual=JSON.parse(raw);
 if(actual.metadata.labels?.['telegram-pi.dev/fixture-owner']!==d.metadata.labels['telegram-pi.dev/fixture-owner']) throw Error(`Refuse unrelated resource: ${d.kind}/${d.metadata.name}`);
 if(d.kind==='Secret' && JSON.stringify(Object.entries(actual.data??{}).sort())!==JSON.stringify(Object.entries(d.data).sort())) throw Error(`Refuse credential replacement: ${d.metadata.name}`);
}
JS
# Keep client errors private: Secret payloads must not enter terminal logs.
"${k[@]}" apply --server-side --field-manager=telegram-pi-application-db-fixture \
  -f "$state/resources.private.json" > "$state/apply.private.log" 2>&1 || {
    echo "Application fixture apply failed; inspect $state/apply.private.log privately." >&2; exit 1;
  }
"${k[@]}" -n telegram-pi rollout status deployment/telegram-pi-postgres --timeout=180s
"${k[@]}" -n telegram-pi wait pvc/telegram-pi-postgres-data --for=jsonpath='{.status.phase}'=Bound --timeout=60s
# Use TCP and each role's actual password. No migrations, durable test tables,
# DML grants, or Substrate connections are made by these checks.
"${k[@]}" -n telegram-pi exec deployment/telegram-pi-postgres -- sh -eu -c '
  export PGPASSWORD="$(cat /run/fixture/owner-password)"
  test "$(psql -XAt -h 127.0.0.1 -U telegram_pi_owner -d telegram_pi -v ON_ERROR_STOP=1 -c "SELECT current_user = pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()")" = t
  test "$(psql -XAt -h 127.0.0.1 -U telegram_pi_owner -d telegram_pi -v ON_ERROR_STOP=1 -c "SELECT current_user = pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = '\''public'\''")" = t
  export PGPASSWORD="$(cat /run/fixture/app-password)"
  test "$(psql -XAt -h 127.0.0.1 -U telegram_pi_gateway -d telegram_pi -v ON_ERROR_STOP=1 -c "SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AND NOT pg_has_role(current_user, '\''telegram_pi_owner'\'', '\''MEMBER'\'') AND NOT has_database_privilege(current_user, current_database(), '\''CREATE'\'') AND NOT has_schema_privilege(current_user, '\''public'\'', '\''CREATE'\'') FROM pg_roles WHERE rolname = current_user")" = t
  if psql -XAt -h 127.0.0.1 -U telegram_pi_gateway -d postgres -c "SELECT 1" >/dev/null 2>&1; then exit 1; fi
  export PGPASSWORD="$(cat /run/fixture/admin-password)"
  test "$(psql -XAt -h 127.0.0.1 -U postgres -d telegram_pi -v ON_ERROR_STOP=1 -c "SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname NOT IN ('\''postgres'\'', '\''template0'\'', '\''template1'\'', '\''telegram_pi'\'')) AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname LIKE '\''substrate%'\'') AND NOT has_database_privilege('\''telegram_pi_gateway'\'', '\''telegram_pi'\'', '\''TEMP'\'')")" = t
  printf "owner database/schema ownership: PASS\napp login and privilege boundary: PASS\nadmin database access denied to app: PASS\nseparate instance, no Substrate database or roles: PASS\n"
' > "$state/checks.txt"
"${k[@]}" -n telegram-pi get deployment/telegram-pi-postgres pvc/telegram-pi-postgres-data service/telegram-pi-postgres -o json > "$state/installed.json"
sha256sum tests/kind/application-postgres.yaml scripts/prepare-application-db-kind.sh > "$state/SHA256SUMS"
printf 'Application PostgreSQL fixture is ready. Checks: %s/checks.txt\n' "$state"
