import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { proveRemoteReads } from "../actor/remote-evidence.mts"
import { redact, repeatOperation, reviewedApplication } from "./checks.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const sha = process.argv[2]
assert.match(sha ?? "", /^[0-9a-f]{40}$/, "Supply the full reviewed immutable Git SHA")
assert.equal(process.argv[3], "--reviewed-runtime-gate", "Main must open the runtime gate")
const kubeconfig = `${root}.cache/kind/kubeconfig`
const context = "kind-telegram-pi-validation"
assert(existsSync(kubeconfig))
const runId = randomBytes(8).toString("hex")
const evidence = `${root}.cache/e2e/${runId}`
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const flags = ["--kubeconfig", kubeconfig, "--context", context]
const kubectl = existsSync(`${root}.cache/tools/kubectl`)
  ? `${root}.cache/tools/kubectl`
  : "kubectl"
const pod = `e2e-client-${runId}`
const ns = "telegram-pi"
const apps = ["substrate-platform", "telegram-pi"]
let created = false
let success = false
let current = "read-only preflight"
const summary = { runId, sha, context, kubeconfig, result: "BLOCKED", phases: [] }
let failures = 0
function command(binary, args, input) {
  try {
    return execFileSync(binary, args, {
      cwd: root,
      input,
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, KUBECONFIG: kubeconfig },
    })
  } catch (error) {
    keep(`command-failure-${++failures}.json`, {
      phase: current,
      status: error.status ?? null,
      stdout: redact(error.stdout ?? ""),
      stderr: redact(error.stderr ?? ""),
    })
    throw new Error(`Command failed during ${current}; inspect retained phase evidence`)
  }
}
function k(args, input) {
  return command(kubectl, [...flags, ...args], input)
}
function json(args) {
  return JSON.parse(k([...args, "-o", "json"]))
}
function keep(name, value) {
  writeFileSync(
    `${evidence}/${name}`,
    typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2),
    { mode: 0o600 },
  )
}
function checkApp(app, ready = true) {
  return reviewedApplication(app, sha, ready)
}
async function sync(pass) {
  for (const name of apps) {
    current = `Argo repeat sync ${pass}: ${name}`
    const app = checkApp(json(["-n", "argocd", "get", "application", name]))
    assert(!app.operation, "An Argo operation is already active")
    const marker = `task12-${runId}-${pass}`
    k([
      "-n",
      "argocd",
      "patch",
      "application",
      name,
      "--type=merge",
      "-p",
      JSON.stringify(repeatOperation(sha, marker, app.spec.syncPolicy?.syncOptions ?? [])),
    ])
    const deadline = Date.now() + 240_000
    for (;;) {
      const actual = checkApp(json(["-n", "argocd", "get", "application", name]), false)
      const op = actual.status?.operationState
      if (op?.operation?.initiatedBy?.username === marker) {
        assert(!["Failed", "Error"].includes(op.phase), "Argo reconciliation failed")
        if (
          op.phase === "Succeeded" &&
          !actual.operation &&
          actual.status?.sync?.status === "Synced" &&
          actual.status?.health?.status === "Healthy"
        ) {
          checkApp(actual)
          assert.equal(op.syncResult.revision, sha)
          keep(`argocd-${pass}-${name}.json`, actual)
          break
        }
      }
      assert(Date.now() < deadline, "Argo health/sync wait timed out")
      await sleep(1000)
    }
  }
}
function caHashes() {
  return json(["get", "clustertrustbundles"])
    .items.map((item) => ({
      name: item.metadata.name,
      signer: item.spec.signerName,
      sha256: createHash("sha256").update(item.spec.trustBundle).digest("hex"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
function poolStatus() {
  const pool = json(["-n", ns, "get", "workerpool", "telegram-pi"])
  assert.equal(pool.spec.replicas, 2)
  assert.equal(pool.status.readyReplicas, 2)
  assert.equal(pool.metadata.labels.workload, "telegram-pi")
  const pods = json(["-n", ns, "get", "pods", "-l", "ate.dev/worker-pool=telegram-pi"]).items
  assert.equal(pods.length, 2, "The application must have exactly two worker Pods")
  assert(
    pods.every(
      (p) =>
        !p.metadata.deletionTimestamp &&
        p.status.conditions.some((c) => c.type === "Ready" && c.status === "True"),
    ),
  )
  return { pool, pods }
}
function phase(name, actor) {
  current = name
  const output = k([
    "-n",
    ns,
    "exec",
    pod,
    "--",
    "node",
    "build/tests/e2e/client.js",
    name,
    runId,
    ...(actor ? [actor] : []),
  ])
  keep(`${name}${actor ? `-${actor}` : ""}.log`, output)
  process.stdout.write(output)
  summary.phases.push({ name, actor, result: "PASS" })
  keep("summary.json", summary)
}
function readClient(path) {
  return k([
    "-n",
    ns,
    "exec",
    pod,
    "--",
    "node",
    "-e",
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(`/tmp/e2e-${runId}/${path}`)}))`,
  ])
}
function state() {
  const data = readClient("state.json")
  keep("state.json", data)
  return JSON.parse(data)
}
function collect() {
  if (created) {
    for (const path of ["state.json", "observations.jsonl", "fixture-final.json"]) {
      try {
        keep(path, readClient(path))
      } catch {
        /* Missing evidence is retained as a failed phase, not a pass. */
      }
    }
  }
  for (const [name, args] of [
    ["gateway.log", ["-n", ns, "logs", "deployment/telegram-pi-gateway", "--all-pods=true"]],
    ["atelet.log", ["-n", "ate-system", "logs", "daemonset/atelet", "-c", "atelet"]],
    [
      "objectstore-plugin.log",
      ["-n", "ate-system", "logs", "daemonset/atelet", "-c", "objectstore-plugin"],
    ],
    [
      "egress.log",
      [
        "-n",
        "ate-system",
        "logs",
        "deployment/atenet-egress",
        "--all-containers=true",
        "--all-pods=true",
      ],
    ],
  ]) {
    try {
      keep(name, redact(k(args)))
    } catch {
      keep(`${name}.unavailable`, "Log collection failed; no evidence inferred.\n")
    }
  }
}
try {
  assert.equal(command("git", ["cat-file", "-t", sha]).toString().trim(), "commit")
  command("git", [
    "diff",
    "--exit-code",
    sha,
    "--",
    "src",
    "charts",
    "deploy",
    "Dockerfile.actor",
    "Dockerfile.gateway",
    "package.json",
    "package-lock.json",
  ])
  assert.equal(
    command("git", [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "src",
      "charts",
      "deploy",
    ]).toString(),
    "",
    "Production sources must be present in the reviewed commit",
  )
  assert.deepEqual(
    json(["get", "nodes"]).items.map((n) => n.metadata.name),
    ["telegram-pi-validation-control-plane"],
  )
  assert.equal(
    command("docker", ["inspect", "--format", "{{.Id}}", "telegram-pi-validation-control-plane"])
      .toString()
      .trim(),
    readFileSync(`${root}.cache/kind/node-id`, "utf8").trim(),
  )
  assert.equal(
    command("docker", [
      "inspect",
      "--format",
      '{{index .Config.Labels "telegram-pi-owner"}}',
      "telegram-pi-validation-registry",
    ])
      .toString()
      .trim(),
    readFileSync(`${root}.cache/kind/owner`, "utf8").trim(),
  )
  for (const name of apps)
    keep(
      `argocd-initial-${name}.json`,
      checkApp(json(["-n", "argocd", "get", "application", name])),
    )
  const deployment = json(["-n", ns, "get", "deployment", "telegram-pi-gateway"])
  assert.equal(deployment.spec.replicas, 1)
  assert.equal(deployment.spec.strategy.type, "Recreate")
  assert.equal(deployment.status.readyReplicas, 1)
  const gateway = deployment.spec.template.spec.containers.find((c) => c.name === "gateway")
  assert.match(gateway.image, /^localhost:25071\/telegram-pi-gateway@sha256:[a-f0-9]{64}$/)
  const env = (name) => gateway.env.find((e) => e.name === name)
  assert.equal(env("TELEGRAM_API_BASE_URL").value, "https://synthetic-api.telegram-pi-fixtures.svc")
  assert.equal(env("TELEGRAM_ALLOWED_USER_IDS").value, "101")
  assert.equal(env("WORKER_POOL_NAME").value, "telegram-pi")
  const dbSecret = env("DATABASE_URL").valueFrom.secretKeyRef
  assert.equal(dbSecret.name, "telegram-pi-database-app")
  keep("deployment.json", deployment)
  keep("workerpool-before.json", poolStatus())
  const ca = caHashes()
  keep("ca-before.json", ca)
  await sync(1)

  current = "test-client build in isolated registry"
  const tag = `localhost:25071/telegram-pi-e2e-client:${runId}`
  keep(
    "client-build.log",
    redact(command("docker", ["build", "-f", "tests/e2e/Dockerfile.client", "-t", tag, "."])),
  )
  keep("client-push.log", command("docker", ["push", tag]))
  const image = command("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", tag])
    .toString()
    .trim()
  assert.match(image, /^localhost:25071\/telegram-pi-e2e-client@sha256:[a-f0-9]{64}$/)
  keep("client-image.txt", `${image}\n`)
  const manifest = {
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: pod, namespace: ns },
        spec: {
          podSelector: { matchLabels: { "telegram-pi/e2e-run": runId } },
          policyTypes: ["Ingress", "Egress"],
          ingress: [],
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                  },
                },
              ],
              ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
              ],
            },
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": "ate-system" },
                  },
                  podSelector: {
                    matchExpressions: [
                      { key: "app", operator: "In", values: ["ate-api-server", "atenet-router"] },
                    ],
                  },
                },
              ],
              ports: [{ protocol: "TCP", port: 8443 }],
            },
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": "telegram-pi-fixtures" },
                  },
                  podSelector: { matchLabels: { "app.kubernetes.io/name": "synthetic-api" } },
                },
              ],
              ports: [{ protocol: "TCP", port: 8443 }],
            },
            {
              to: [{ podSelector: { matchLabels: { app: "telegram-pi-postgres" } } }],
              ports: [{ protocol: "TCP", port: 5432 }],
            },
          ],
        },
      },
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: `${pod}-database`, namespace: ns },
        spec: {
          podSelector: { matchLabels: { app: "telegram-pi-postgres" } },
          policyTypes: ["Ingress"],
          ingress: [
            {
              from: [{ podSelector: { matchLabels: { "telegram-pi/e2e-run": runId } } }],
              ports: [{ protocol: "TCP", port: 5432 }],
            },
          ],
        },
      },
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: pod, namespace: ns, labels: { "telegram-pi/e2e-run": runId } },
        spec: {
          serviceAccountName: "gateway",
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "client",
              image,
              env: [
                ...gateway.env.filter((e) =>
                  [
                    "SUBSTRATE_ATESPACE",
                    "ACTOR_TEMPLATE",
                    "ACTOR_IMAGE",
                    "LLM_CREDENTIAL_URI",
                  ].includes(e.name),
                ),
                { name: "NODE_EXTRA_CA_CERTS", value: "/var/run/ate/ca.crt" },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: { cpu: "10m", memory: "64Mi" },
                limits: { cpu: "500m", memory: "512Mi" },
              },
              volumeMounts: [
                { name: "identity", mountPath: "/var/run/ate", readOnly: true },
                { name: "database", mountPath: "/var/run/database", readOnly: true },
                { name: "scratch", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            { name: "scratch", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
            {
              name: "database",
              projected: {
                defaultMode: 0o440,
                sources: [
                  { secret: { name: dbSecret.name, items: [{ key: dbSecret.key, path: "url" }] } },
                ],
              },
            },
            {
              name: "identity",
              projected: {
                defaultMode: 0o440,
                sources: [
                  {
                    clusterTrustBundle: {
                      signerName: "servicedns.podcert.ate.dev/identity",
                      labelSelector: { matchLabels: { "podcert.ate.dev/canarying": "live" } },
                      path: "ca.crt",
                    },
                  },
                  {
                    podCertificate: {
                      signerName: "podidentity.podcert.ate.dev/identity",
                      keyType: "ECDSAP256",
                      credentialBundlePath: "credential-bundle.pem",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  }
  keep("client.json", manifest)
  current = "dedicated narrow gateway-identity test client admission"
  k(["create", "-f", "-"], JSON.stringify(manifest))
  created = true
  k(["-n", ns, "wait", "--for=condition=Ready", `pod/${pod}`, "--timeout=180s"])
  phase("baseline")
  phase("reject")
  phase("admit")
  phase("restart-boundary")
  current = "restart the single Gateway Pod, preserve data"
  const old = json(["-n", ns, "get", "pods", "-l", "app=telegram-pi-gateway"]).items
  assert.equal(old.length, 1)
  keep("gateway-before-restart.json", old[0])
  k(["-n", ns, "delete", "pod", old[0].metadata.name, "--wait=true", "--timeout=90s"])
  k(["-n", ns, "rollout", "status", "deployment/telegram-pi-gateway", "--timeout=180s"])
  const replacement = json(["-n", ns, "get", "pods", "-l", "app=telegram-pi-gateway"]).items
  assert.equal(replacement.length, 1)
  assert.notEqual(replacement[0].metadata.uid, old[0].metadata.uid)
  keep("gateway-after-restart.json", replacement[0])
  phase("verify")
  phase("reuse")

  for (const fidelity of ["memory", "cold"]) {
    phase(`remote-prepare-${fidelity}`)
    const item = state().remote.at(-1)
    phase("remote-detach", item.name)
    current = "verify no node-local private checkpoint exists"
    command("docker", [
      "exec",
      "telegram-pi-validation-control-plane",
      "test",
      "!",
      "-e",
      `/var/lib/ate/snapshots/${item.before.actorUid}/local-checkpoint/${item.snapshot.uuid}`,
    ])
    phase("remote-verify", item.name)
    current = "verify exact private remote object reads"
    const atelet = k(["-n", "ate-system", "logs", "daemonset/atelet", "-c", "atelet"]).toString()
    const objects = k([
      "-n",
      "ate-system",
      "logs",
      "daemonset/atelet",
      "-c",
      "objectstore-plugin",
    ]).toString()
    keep(`atelet-${fidelity}.log`, redact(atelet))
    keep(`objects-${fidelity}.log`, redact(objects))
    keep(`remote-read-${fidelity}.json`, proveRemoteReads([item], atelet, objects))
    phase("remote-finish", item.name)
  }

  current = "credential-provider actual restricted Kubernetes reads"
  const principal = "system:serviceaccount:ate-system:k8s-credential-provider"
  keep(
    "provider-allowed.txt",
    k([
      "--as",
      principal,
      "-n",
      "telegram-pi-llm",
      "get",
      "secret",
      "openai-fixture",
      "-o",
      "name",
    ]),
  )
  for (const [namespace, name] of [
    [ns, "telegram-bot"],
    ["ate-system", "rustfs-credentials"],
  ]) {
    let denial
    try {
      execFileSync(
        kubectl,
        [...flags, "--as", principal, "-n", namespace, "get", "secret", name, "-o", "name"],
        { cwd: root, timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] },
      )
    } catch (error) {
      denial = error
    }
    assert.equal(denial?.status, 1, "Provider must not read an unauthorized Secret")
    const message = denial.stderr.toString()
    assert.match(message, /Forbidden/)
    assert(message.includes(principal), "A network failure is not an RBAC denial")
    keep(`provider-denied-${namespace}-${name}.txt`, redact(message))
  }
  await sync(2)
  phase("final")
  assert.deepEqual(caHashes(), ca, "Reconciliation changed CA trust bundles")
  keep("ca-after.json", caHashes())
  keep("workerpool-after.json", poolStatus())
  success = true
} catch (error) {
  summary.blockedAt = current
  summary.error =
    error instanceof assert.AssertionError
      ? error.message.split("\n")[0]
      : "Runtime command failed; no check was skipped or inferred"
  console.error(`E2E failed at ${current}. Evidence: ${evidence}`)
} finally {
  collect()
  summary.result = success ? "PASS" : "FAIL"
  summary.clientPod = created ? `${ns}/${pod}` : "not created"
  summary.retained =
    "No fixture reset, Actor deletion, database deletion, or automatic resource cleanup"
  keep("summary.json", summary)
  keep(
    "report.md",
    `# Packaged kind E2E\n\nResult: ${summary.result}\n\nReviewed revision: ${sha}\n\nEvidence: ${evidence}\n\n${summary.blockedAt ? `Blocked phase: ${summary.blockedAt}\n\n` : ""}Client: ${summary.clientPod}. Resources and data are retained. No live Telegram/model or production acceptance is claimed.\n`,
  )
  console.log(`E2E ${summary.result}. Evidence: ${evidence}`)
  if (!success) process.exitCode = 1
}
