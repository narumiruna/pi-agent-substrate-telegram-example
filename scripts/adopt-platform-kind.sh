#!/usr/bin/env bash
# One-time adoption of unchanged local RustFS credentials, before Argo reconciliation.
set +x
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
[[ $# == 0 ]]
[[ -f .cache/kind/node-id && -f .cache/kind/owner ]]
[[ "$(docker inspect --format '{{.Id}}' telegram-pi-validation-control-plane)" == "$(< .cache/kind/node-id)" ]]
[[ "$(docker inspect --format '{{index .Config.Labels "telegram-pi-owner"}}' telegram-pi-validation-registry)" == "$(< .cache/kind/owner)" ]]
node --input-type=module <<'JS'
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {parseAllDocuments} from 'yaml';
const flags=['--kubeconfig',`${process.cwd()}/.cache/kind/kubeconfig`,'--context','kind-telegram-pi-validation'];
function k(args,input){return execFileSync('kubectl',[...flags,...args],{input,encoding:'utf8',timeout:180000,stdio:['pipe','pipe','pipe']});}
let phase='credential Secret read';
try {
  const secret=JSON.parse(k(['-n','ate-system','get','secret','rustfs-credentials','-o','json']));
  phase='local platform render';
  const desired=parseAllDocuments(k(['kustomize','deploy/platform'])).map(d=>d.toJS()).filter(Boolean);
  const changes=[];
  for(const object of desired.filter(o=>o.metadata?.namespace==='ate-system' && ['Deployment','DaemonSet'].includes(o.kind))){
    phase=`preflight ${object.kind}/${object.metadata.name}`;
    const live=JSON.parse(k(['-n','ate-system','get',object.kind,object.metadata.name,'-o','json']));
    const patch=[];
    for(const type of ['containers','initContainers']){
      for(const container of object.spec.template.spec[type]??[]){
        const actual=live.spec.template.spec[type]??[];
        const ci=actual.findIndex(c=>c.name===container.name);
        if(ci<0)throw Error('Missing expected container');
        for(const variable of container.env??[]){
          const ref=variable.valueFrom?.secretKeyRef;
          if(ref?.name!=='rustfs-credentials')continue;
          if(!secret.data?.[ref.key])throw Error('Missing credential key');
          const expected=Buffer.from(secret.data[ref.key],'base64').toString();
          const ei=(actual[ci].env??[]).findIndex(e=>e.name===variable.name);
          if(ei<0)throw Error('Missing credential environment');
          const current=actual[ci].env[ei];
          if(current.valueFrom){
            if(current.valueFrom.secretKeyRef?.name!==ref.name || current.valueFrom.secretKeyRef?.key!==ref.key)throw Error('Unexpected credential reference');
            continue;
          }
          if(current.value!==expected)throw Error('Credential difference; adoption refused');
          const path=`/spec/template/spec/${type}/${ci}/env/${ei}`;
          patch.push({op:'test',path:`${path}/value`,value:expected},{op:'remove',path:`${path}/value`},{op:'add',path:`${path}/valueFrom`,value:variable.valueFrom});
        }
      }
    }
    if(patch.length)changes.push({kind:object.kind,name:object.metadata.name,patch});
  }
  // Preflight all credential values before the first write. Never output a patch or Secret.
  for(const change of changes){
    phase=`adopt ${change.kind}/${change.name}`;
    const temporary=mkdtempSync('.cache/kind/adoption-private-');
    try {
      const patchFile=`${temporary}/patch.json`;
      writeFileSync(patchFile,JSON.stringify(change.patch),{mode:0o600});
      k(['-n','ate-system','patch',change.kind,change.name,'--type=json',`--patch-file=${patchFile}`]);
    } finally {rmSync(temporary,{recursive:true,force:true});}
    console.log(`${change.kind}/${change.name}: unchanged credentials adopted`);
  }
  for(const change of changes)k(['-n','ate-system','rollout','status',`${change.kind}/${change.name}`,'--timeout=180s']);
  console.log('Platform credential adoption complete; no signing pools or data were changed.');
} catch(error) { console.error(`Platform adoption stopped during ${phase}.`); if(['Missing expected container','Missing credential key','Missing credential environment','Unexpected credential reference','Credential difference; adoption refused'].includes(error.message))console.error(error.message); console.error('Inspect the isolated resources privately; do not rotate credentials.'); process.exitCode=1; }
JS
