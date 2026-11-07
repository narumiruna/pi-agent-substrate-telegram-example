#!/usr/bin/env bash
# Install core Argo CD only. Never create Applications, sync, or restart platform.
set +x
set -euo pipefail
umask 077
cd "$(dirname "${BASH_SOURCE[0]}")/.."
root="$PWD"
[[ "$root" == /home/narumi/src/pi-agent-substrate-telegram-example ]] || {
  echo 'Refuse a different repository path.' >&2; exit 1;
}
[[ $# == 0 ]] || { echo 'Usage: bash scripts/prepare-argocd-kind.sh' >&2; exit 2; }
kubeconfig="$root/.cache/kind/kubeconfig"
context=kind-telegram-pi-validation
k=(kubectl --kubeconfig "$kubeconfig" --context "$context")
[[ -f .cache/kind/node-id && -f .cache/kind/owner && -f "$kubeconfig" ]]
[[ "$(docker inspect --format '{{.Id}}' telegram-pi-validation-control-plane)" == "$(< .cache/kind/node-id)" ]]
[[ "$(docker inspect --format '{{index .Config.Labels "telegram-pi-owner"}}' telegram-pi-validation-registry)" == "$(< .cache/kind/owner)" ]]
"${k[@]}" get node telegram-pi-validation-control-plane -o name >/dev/null
state="$root/.cache/kind/argocd-bootstrap"
mkdir -p "$state/home" "$state/xdg"
chmod 700 "$state" "$state/home" "$state/xdg"
exec 9>"$state/lock"
flock -n 9 || { echo 'Argo fixture preparation is already running.' >&2; exit 1; }
node --input-type=module - "$state" <<'JS'
import fs from 'node:fs'; import {randomBytes,createHash} from 'node:crypto';
const state=process.argv[2], lock=JSON.parse(fs.readFileSync('tests/kind/argocd-lock.json'));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
if(hash('.cache/tools/argocd')!==lock.cliSha256) throw Error('Argo CLI checksum mismatch');
const path=`${state}/owner`;
if(!fs.existsSync(path)) fs.writeFileSync(path,randomBytes(16).toString('hex'),{mode:0o600,flag:'wx'});
const s=fs.lstatSync(path);
if(!s.isFile() || (s.mode & 0o077) || !/^[a-f0-9]{32}$/.test(fs.readFileSync(path,'utf8').trim())) throw Error('Unsafe ownership record');
fs.writeFileSync(`${state}/source-url`,lock.sourceUrl+'\n',{mode:0o600});
JS
curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 --max-time 120 \
  "$(< "$state/source-url")" -o "$state/core-install.download"
node --input-type=module - "$state" <<'JS'
import fs from 'node:fs'; import {createHash} from 'node:crypto'; import {parseAllDocuments} from 'yaml';
const state=process.argv[2], lock=JSON.parse(fs.readFileSync('tests/kind/argocd-lock.json'));
const source=fs.readFileSync(`${state}/core-install.download`);
if(createHash('sha256').update(source).digest('hex')!==lock.sourceSha256) throw Error('Argo source checksum mismatch');
fs.renameSync(`${state}/core-install.download`,`${state}/core-install.yaml`);
const owner=fs.readFileSync(`${state}/owner`,'utf8').trim(), labels={'telegram-pi.dev/fixture-owner':owner};
const parse=path=>parseAllDocuments(fs.readFileSync(path,'utf8')).map(d=>{if(d.errors.length)throw Error(`Invalid YAML: ${path}`); return d.toJS();});
const docs=[{apiVersion:'v1',kind:'Namespace',metadata:{name:'argocd'}},...parse(`${state}/core-install.yaml`),...parse('deploy/argocd/projects.yaml')];
const health=parse('deploy/argocd/health.yaml')[0];
const cm=docs.find(d=>d.kind==='ConfigMap'&&d.metadata.name==='argocd-cm');
cm.data={...cm.data,...health.data};
for(const d of docs){
 if(['Application','ApplicationSet'].includes(d.kind)) throw Error('Applications are forbidden before the commit gate');
 d.metadata.labels={...d.metadata.labels,...labels};
 if(!['Namespace','CustomResourceDefinition','ClusterRole','ClusterRoleBinding'].includes(d.kind)) d.metadata.namespace='argocd';
 if(d.kind==='Service' && d.spec?.type && d.spec.type!=='ClusterIP') throw Error('Service exposure is forbidden');
 if(d.spec?.template){
  d.spec.template.metadata.labels={...d.spec.template.metadata.labels,...labels};
  for(const c of [...d.spec.template.spec.containers??[],...d.spec.template.spec.initContainers??[]]){
   if(!lock.images[c.image]) throw Error('Unpinned Argo image');
   c.image=lock.images[c.image];
  }
 }
}
const save=(name,items)=>fs.writeFileSync(`${state}/${name}`,JSON.stringify({apiVersion:'v1',kind:'List',items}),{mode:0o600});
save('install.json',docs);
save('core.json',docs.filter(d=>d.kind!=='AppProject'));
save('projects.json',docs.filter(d=>d.kind==='AppProject'));
fs.copyFileSync('tests/kind/argocd-lock.json',`${state}/provenance.json`);
fs.chmodSync(`${state}/provenance.json`,0o600);
JS
# Preflight every intended object before any write, including cluster-scoped
# RBAC/CRDs. Labels must match this private run record, not just an Argo name.
node --input-type=module - "$state" "$kubeconfig" "$context" <<'JS'
import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const [state,kubeconfig,context]=process.argv.slice(2);
const call=args=>{const r=spawnSync('kubectl',['--kubeconfig',kubeconfig,'--context',context,...args],{encoding:'utf8',maxBuffer:32*1024*1024}); if(r.status!==0) throw Error(`Argo resource preflight failed: ${args.slice(0,3).join(' ')}`);return r.stdout.trim();};
const docs=JSON.parse(fs.readFileSync(`${state}/install.json`)).items;
for(const d of docs){
 if(d.kind==='AppProject' && !call(['get','crd','appprojects.argoproj.io','--ignore-not-found','-o','json'])) continue;
 const args=['get',d.kind,d.metadata.name,'--ignore-not-found','-o','json'];
 if(d.metadata.namespace) args.push('-n',d.metadata.namespace);
 const raw=call(args);
 if(raw && JSON.parse(raw).metadata.labels?.['telegram-pi.dev/fixture-owner']!==d.metadata.labels['telegram-pi.dev/fixture-owner']) throw Error(`Refuse unrelated resource: ${d.kind}/${d.metadata.name}`);
}
// An existing owned installation must still have no Applications to reconcile.
for(const kind of ['applications','applicationsets']){
 const crd=call(['get','crd',`${kind}.argoproj.io`,'--ignore-not-found','-o','json']);
 if(crd && JSON.parse(call(['get',kind,'-A','-o','json'])).items.length) throw Error('Commit gate is closed: existing Applications/ApplicationSets require operator review');
}
JS
# Read the current fixture's values privately. This is not a rotation and does
# not change its Deployment. Resolve existing Secret refs after later adoption.
"${k[@]}" -n ate-system get deployment rustfs -o json > "$state/rustfs-private.json"
node --input-type=module - "$state" "$kubeconfig" "$context" <<'JS'
import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const [state,kubeconfig,context]=process.argv.slice(2);
const call=args=>{const r=spawnSync('kubectl',['--kubeconfig',kubeconfig,'--context',context,...args],{encoding:'utf8'});if(r.status!==0)throw Error('RustFS private prerequisite read failed');return r.stdout.trim();};
const d=JSON.parse(fs.readFileSync(`${state}/rustfs-private.json`));
const env=d.spec.template.spec.containers.find(c=>c.name==='rustfs')?.env;
const value=name=>{
 const e=env?.find(e=>e.name===name);
 if(typeof e?.value==='string' && e.value) return e.value;
 const ref=e?.valueFrom?.secretKeyRef;
 if(!ref) throw Error('RustFS credential source is not supported; do not rotate');
 const s=JSON.parse(call(['get','secret',ref.name,'-n','ate-system','-o','json']));
 if(!s.data?.[ref.key]) throw Error('RustFS credential source is missing');
 return Buffer.from(s.data[ref.key],'base64').toString();
};
const data={'access-key':Buffer.from(value('RUSTFS_ACCESS_KEY')).toString('base64'),'secret-key':Buffer.from(value('RUSTFS_SECRET_KEY')).toString('base64')};
const owner=fs.readFileSync(`${state}/owner`,'utf8').trim();
const raw=call(['get','secret','rustfs-credentials','-n','ate-system','--ignore-not-found','-o','json']);
if(raw){
 const s=JSON.parse(raw);
 if(s.metadata.labels?.['telegram-pi.dev/fixture-owner']!==owner) throw Error('Refuse unrelated RustFS Secret');
 if(JSON.stringify(Object.entries(s.data??{}).sort())!==JSON.stringify(Object.entries(data).sort())) throw Error('Refuse RustFS credential change');
}
fs.writeFileSync(`${state}/rustfs-secret.private.json`,JSON.stringify({apiVersion:'v1',kind:'Secret',metadata:{name:'rustfs-credentials',namespace:'ate-system',labels:{'telegram-pi.dev/fixture-owner':owner}},type:'Opaque',data}),{mode:0o600});
fs.writeFileSync(`${state}/rustfs-before.json`,JSON.stringify({uid:d.metadata.uid,generation:d.metadata.generation,template:d.spec.template}),{mode:0o600});
JS
"${k[@]}" -n ate-system apply --server-side --field-manager=telegram-pi-rustfs-secret-fixture \
  -f "$state/rustfs-secret.private.json" > "$state/rustfs-apply.private.log" 2>&1 || {
    echo "RustFS Secret check failed; inspect $state/rustfs-apply.private.log privately." >&2; exit 1;
  }
"${k[@]}" apply --server-side --field-manager=telegram-pi-argocd-fixture \
  -f "$state/core.json" > "$state/apply.private.log" 2>&1 || {
    echo "Argo install failed; inspect $state/apply.private.log privately." >&2; exit 1;
  }
for crd in applications applicationsets appprojects; do
  "${k[@]}" wait --for=condition=Established "crd/$crd.argoproj.io" --timeout=120s
done
"${k[@]}" apply --server-side --field-manager=telegram-pi-argocd-fixture \
  -f "$state/projects.json" >> "$state/apply.private.log" 2>&1 || {
    echo "Argo project setup failed; inspect $state/apply.private.log privately." >&2; exit 1;
  }
for name in argocd-redis argocd-repo-server argocd-applicationset-controller; do
  "${k[@]}" -n argocd rollout status "deployment/$name" --timeout=180s
done
"${k[@]}" -n argocd rollout status statefulset/argocd-application-controller --timeout=180s
# Core CLI takes its namespace from this isolated kubeconfig. Do not edit any
# other kubeconfig, Argo config, inherited auth, or host settings.
"${k[@]}" config set-context "$context" --namespace=argocd > "$state/context.txt"
env -i HOME="$state/home" PATH="$PATH" XDG_CONFIG_HOME="$state/xdg" KUBECONFIG="$kubeconfig" \
  timeout 90 "$root/.cache/tools/argocd" --core --kube-context "$context" \
  --config "$state/cli-config" --prompts-enabled=false app list --app-namespace argocd -o json \
  > "$state/core-app-list.json" 2> "$state/core-cli.log"
"${k[@]}" -n argocd exec deployment/argocd-repo-server -c argocd-repo-server -- \
  env GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.interactive=false \
  ls-remote https://github.com/narumiruna/pi-agent-substrate-telegram-example.git HEAD \
  > "$state/public-repo-head.txt" 2> "$state/public-repo-check.log"
"${k[@]}" -n argocd get pods,deployments,statefulsets,services,appprojects,applications,applicationsets -o json > "$state/installed.json"
"${k[@]}" -n ate-system get deployment rustfs -o json > "$state/rustfs-after.private.json"
node --input-type=module - "$state" <<'JS'
import fs from 'node:fs'; import {isDeepStrictEqual} from 'node:util';
const state=process.argv[2], read=p=>JSON.parse(fs.readFileSync(`${state}/${p}`));
const apps=read('core-app-list.json');
if((Array.isArray(apps)?apps:apps.items??[]).length) throw Error('Unexpected Application');
const installed=read('installed.json');
if(installed.items.some(d=>['Application','ApplicationSet'].includes(d.kind))) throw Error('Commit gate violated');
if(installed.items.some(d=>d.kind==='Service' && d.spec.type!=='ClusterIP')) throw Error('Unexpected service exposure');
const before=read('rustfs-before.json'), after=read('rustfs-after.private.json');
if(before.uid!==after.metadata.uid || before.generation!==after.metadata.generation || !isDeepStrictEqual(before.template,after.spec.template)) throw Error('RustFS Deployment changed during preparation; retain evidence');
fs.writeFileSync(`${state}/checks.txt`,'pinned source, CLI, and container digests: PASS\ncore CLI against isolated API: PASS\npublic GitHub repository access from repo-server: PASS\nApplications and ApplicationSets absent: PASS\nall Argo services ClusterIP; no API/UI server deployed: PASS\nRustFS credential Secret preserves current values; Deployment unchanged: PASS\n',{mode:0o600});
JS
sha256sum "$state/core-install.yaml" "$state/install.json" tests/kind/argocd-lock.json \
  scripts/prepare-argocd-kind.sh deploy/argocd/projects.yaml deploy/argocd/health.yaml > "$state/SHA256SUMS"
printf 'Argo CD core v3.6.1 is ready. No Applications or sync. Checks: %s/checks.txt\n' "$state"
