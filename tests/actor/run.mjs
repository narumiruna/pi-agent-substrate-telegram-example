import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { proveRemoteReads } from "./remote-evidence.mts"

assert.equal(
  process.argv[2],
  "--identity-gate-ready",
  "Wait for main's task4 runtime identity gate",
)
const root = fileURLToPath(new URL("../../", import.meta.url))
const state = `${root}.cache/actor-runtime`
const kubeconfig = `${root}.cache/kind/kubeconfig`
assert(existsSync(kubeconfig))
mkdirSync(state, { recursive: true })
const flags = ["--kubeconfig", kubeconfig, "--context", "kind-telegram-pi-validation"]
function run(command, args, input) {
  return execFileSync(command, args, {
    cwd: root,
    input,
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  })
}
function k(args, input) {
  return run("kubectl", [...flags, ...args], input)
}
function build(file, name, extra = []) {
  const tag = `localhost:25071/${name}:task5`
  writeFileSync(
    `${state}/${name}-build.log`,
    run("docker", ["build", "--file", file, "--tag", tag, ...extra, "."]),
  )
  writeFileSync(`${state}/${name}-push.log`, run("docker", ["push", tag]))
  const image = run("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", tag])
    .toString()
    .trim()
  assert.match(image, /^localhost:25071\/[a-z-]+@sha256:[0-9a-f]{64}$/)
  writeFileSync(`${state}/${name}-image.txt`, `${image}\n`)
  return image
}
function phase(name) {
  const output = k([
    "--namespace",
    "telegram-pi",
    "exec",
    "actor-runtime-client",
    "--",
    "node",
    "build/tests/actor-runtime.js",
    "--identity-gate-ready",
    name,
  ])
  writeFileSync(`${state}/${name}.log`, output)
  process.stdout.write(output)
}
// This runner never creates grants, edits platform security, or uses administrator credentials in Pods.
assert.equal(
  JSON.parse(k(["get", "nodes", "-o", "json"]))
    .items.map((node) => node.metadata.name)
    .join(","),
  "telegram-pi-validation-control-plane",
)
const nodeId = readFileSync(`${root}.cache/kind/node-id`, "utf8").trim()
assert.equal(
  run("docker", ["inspect", "--format", "{{.Id}}", "telegram-pi-validation-control-plane"])
    .toString()
    .trim(),
  nodeId,
)
assert(
  !JSON.parse(k(["--namespace", "telegram-pi", "get", "pods", "-o", "json"])).items.some(
    (pod) => pod.metadata.name === "actor-runtime-client",
  ),
  "Refuse to replace an existing runtime test Pod",
)
const actor = build("Dockerfile.actor", "telegram-pi-actor")
const proof = build("tests/actor/Dockerfile.proof", "telegram-pi-actor-proof", [
  "--build-arg",
  `ACTOR_IMAGE=${actor}`,
])
const client = build("tests/actor/Dockerfile.client", "telegram-pi-actor-client")
const manifest = readFileSync(`${root}tests/kind/actor-client.yaml.tmpl`, "utf8")
  .replaceAll(`\${CLIENT_IMAGE}`, client)
  .replaceAll(`\${ACTOR_IMAGE}`, proof)
writeFileSync(`${state}/client.yaml`, manifest)
k(["apply", "-f", "-"], manifest)
k([
  "--namespace",
  "telegram-pi",
  "wait",
  "--for=condition=Ready",
  "pod/actor-runtime-client",
  "--timeout=180s",
])
try {
  phase("prepare")
  const snapshotState = k([
    "--namespace",
    "telegram-pi",
    "exec",
    "actor-runtime-client",
    "--",
    "node",
    "-e",
    "process.stdout.write(require('node:fs').readFileSync('/tmp/actor-runtime/state.json'))",
  ])
  writeFileSync(`${state}/state.json`, snapshotState)
  const snapshots = JSON.parse(snapshotState)
  phase("detach")
  // Revert only acted on the latest COMPLETED private snapshots. Assert no local checkpoint remains.
  for (const item of snapshots) {
    assert.match(item.before.actorUid, /^[0-9a-f-]{36}$/)
    assert.match(item.snapshot.uuid, /^[0-9a-f-]{36}$/)
    assert.equal(item.snapshot.owner, 1) // SNAPSHOT_OWNER_ACTOR -> PRIVATE -> shared cache bypassed.
    const local = `/var/lib/ate/snapshots/${item.before.actorUid}/local-checkpoint/${item.snapshot.uuid}`
    run("docker", ["exec", "telegram-pi-validation-control-plane", "test", "!", "-e", local])
  }
  phase("verify")
  const downloads = k([
    "--namespace",
    "ate-system",
    "logs",
    "daemonset/atelet",
    "--container",
    "objectstore-plugin",
  ])
  writeFileSync(`${state}/objectstore-plugin.log`, downloads)
  const atelet = k([
    "--namespace",
    "ate-system",
    "logs",
    "daemonset/atelet",
    "--container",
    "atelet",
  ])
  writeFileSync(`${state}/atelet.log`, atelet)
  const evidence = proveRemoteReads(snapshots, atelet.toString(), downloads.toString())
  writeFileSync(`${state}/remote-read-evidence.json`, JSON.stringify(evidence, null, 2))
  for (const proof of evidence)
    console.log(
      JSON.stringify({
        check: "exact private snapshot read from RustFS through object plugin",
        result: "PASS",
        actorUid: proof.actorUid,
        snapshot: proof.snapshot,
        traceId: proof.traceId,
        files: proof.downloads.length,
      }),
    )
  phase("finish")
  console.log(`Actor remote runtime suite passed. Evidence: ${state}`)
} catch (error) {
  if (error.stdout) {
    writeFileSync(`${state}/failed-phase.log`, error.stdout)
    process.stdout.write(error.stdout)
  }
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  // Keep the client Pod and its evidence after failure. Actors are never automatically deleted.
  console.log(
    "Inspect retained actor-runtime-client and .cache/actor-runtime; remove only this test Pod after evidence review.",
  )
}
