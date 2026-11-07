import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parseAllDocuments } from "yaml"

const root = path.resolve(import.meta.dirname, "../..")
const load = (file) => fs.readFileSync(path.join(root, file), "utf8")

function preflight(script, items, scenario) {
  const source = load(script)
  const start = source.indexOf(
    'node --input-type=module - "$state" "$kubeconfig" "$context" <<\'JS\'\n',
    source.indexOf("# Preflight"),
  )
  assert.notEqual(start, -1)
  const bodyStart = source.indexOf("\n", start) + 1
  const end = source.indexOf("\nJS\n", bodyStart)
  assert.notEqual(end, -1)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-pi-bootstrap-test-"))
  try {
    fs.mkdirSync(path.join(dir, "bin"))
    for (const file of ["install.json", "resources.private.json"]) {
      fs.writeFileSync(path.join(dir, file), JSON.stringify({ items }), { mode: 0o600 })
    }
    fs.writeFileSync(
      path.join(dir, "bin/kubectl"),
      `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]!=='--kubeconfig'||args[1]!=='/fixture-only/kubeconfig'||args[2]!=='--context'||args[3]!=='kind-telegram-pi-validation'||args[4]!=='get') process.exit(91);
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify(args)+'\\n');
const a=args.slice(4), scenario=process.env.TEST_SCENARIO;
if(a[1]==='namespace'&&a[2]==='telegram-pi') console.log(JSON.stringify({metadata:{labels:{'ate.dev/api-access':'true'}}}));
else if(scenario==='applications' && a[1]==='crd') console.log('{}');
else if(scenario==='applications') console.log(JSON.stringify({items:[{kind:'Application'}]}));
else console.log(JSON.stringify({metadata:{labels:{'telegram-pi.dev/fixture-owner':scenario==='secret-change'?'owned':'unrelated'}},data:{url:'different'}}));
`,
      { mode: 0o700 },
    )
    const calls = path.join(dir, "calls.jsonl")
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-", dir, "/fixture-only/kubeconfig", "kind-telegram-pi-validation"],
      {
        input: source.slice(bodyStart, end),
        encoding: "utf8",
        env: {
          PATH: `${dir}/bin:${process.env.PATH}`,
          TEST_CALLS: calls,
          TEST_SCENARIO: scenario,
        },
      },
    )
    assert.notEqual(result.status, 0)
    const recorded = fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse)
    assert(recorded.length > 0)
    assert(recorded.every((a) => a[4] === "get"))
    return result.stderr
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const object = (kind, name) => ({
  kind,
  metadata: {
    name,
    namespace: "telegram-pi",
    labels: { "telegram-pi.dev/fixture-owner": "owned" },
  },
  data: { url: "expected" },
})

test("application fixture refuses unrelated resources before writes", () => {
  assert.match(
    preflight(
      "scripts/prepare-application-db-kind.sh",
      [object("ConfigMap", "fixture")],
      "unrelated",
    ),
    /Refuse unrelated resource/,
  )
})

test("application fixture refuses credential replacement before writes", () => {
  assert.match(
    preflight(
      "scripts/prepare-application-db-kind.sh",
      [object("Secret", "fixture")],
      "secret-change",
    ),
    /Refuse credential replacement/,
  )
})

test("Argo fixture refuses unrelated resources before writes", () => {
  assert.match(
    preflight("scripts/prepare-argocd-kind.sh", [object("Namespace", "argocd")], "unrelated"),
    /Refuse unrelated resource/,
  )
})

test("Argo fixture stops if an Application already exists", () => {
  assert.match(
    preflight("scripts/prepare-argocd-kind.sh", [], "applications"),
    /Commit gate is closed/,
  )
})

test("Argo source and every container image have immutable pins", () => {
  const lock = JSON.parse(load("tests/kind/argocd-lock.json"))
  assert.equal(lock.version, "v3.6.1")
  assert.match(lock.revision, /^[a-f0-9]{40}$/)
  assert(lock.sourceUrl.includes(`/${lock.revision}/manifests/core-install.yaml`))
  assert.match(lock.sourceSha256, /^[a-f0-9]{64}$/)
  assert.match(lock.cliSha256, /^[a-f0-9]{64}$/)
  assert.equal(Object.keys(lock.images).length, 2)
  for (const [tag, digest] of Object.entries(lock.images)) {
    assert.match(digest, /@sha256:[a-f0-9]{64}$/)
    assert(digest.startsWith(`${tag}@`))
  }
})

test("database fixture uses persistent separate storage and chart-compatible labels", () => {
  const docs = parseAllDocuments(load("tests/kind/application-postgres.yaml")).map((d) => d.toJS())
  assert(docs.every((d) => d.metadata.namespace === "telegram-pi" && d.kind !== "Secret"))
  const deployment = docs.find((d) => d.kind === "Deployment")
  assert.equal(deployment.spec.strategy.type, "Recreate")
  assert.equal(deployment.spec.template.metadata.labels.app, "telegram-pi-postgres")
  assert.match(
    deployment.spec.template.spec.containers[0].image,
    /^postgres:18-alpine@sha256:[a-f0-9]{64}$/,
  )
  assert(docs.some((d) => d.kind === "PersistentVolumeClaim"))
  const policy = docs.find((d) => d.kind === "NetworkPolicy")
  const from = policy.spec.ingress[0].from[0]
  assert.equal(from.namespaceSelector.matchLabels["kubernetes.io/metadata.name"], "telegram-pi")
  assert.deepEqual(from.podSelector.matchExpressions[0].values, [
    "telegram-pi-gateway",
    "telegram-pi-migration",
  ])
  assert.deepEqual(policy.spec.egress, [])
  const sql = docs.find((d) => d.kind === "ConfigMap").data["10-application.sh"]
  assert(sql.includes("CREATE DATABASE telegram_pi OWNER telegram_pi_owner"))
  assert(sql.includes("ALTER SCHEMA public OWNER TO telegram_pi_owner"))
  assert(sql.includes("REVOKE ALL ON SCHEMA public FROM PUBLIC"))
  assert(!sql.includes("substrate"))
  for (const script of [
    "scripts/prepare-argocd-kind.sh",
    "scripts/prepare-application-db-kind.sh",
  ]) {
    assert.equal(spawnSync("bash", ["-n", path.join(root, script)]).status, 0)
  }
})
