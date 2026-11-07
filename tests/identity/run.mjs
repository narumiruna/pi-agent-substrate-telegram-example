import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// This is an explicit runtime gate, not an automatic test or an alternative to
// main's task3 smoke + HTTPS fixture approval. This runner never writes grants.
assert.equal(process.argv[2], "--task3-ready", "Wait for main's task3 confirmation first")
const root = fileURLToPath(new URL("../../", import.meta.url))
const kubeconfig = `${root}.cache/kind/kubeconfig`
assert(existsSync(kubeconfig))
const flags = ["--kubeconfig", kubeconfig, "--context", "kind-telegram-pi-validation"]
const namespace = "telegram-pi"
const state = `${root}.cache/identity`
mkdirSync(state, { recursive: true })
const pods = [
  ["identity-gateway", "gateway"],
  ["identity-gateway-renewal", "gateway"],
  ["identity-provisioner", "identity-provisioner"],
  ["identity-ungranted", "identity-ungranted"],
]
function run(command, args, input) {
  return execFileSync(command, args, {
    cwd: root,
    input,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  })
}
function kubectl(args, input) {
  return run("kubectl", [...flags, "--namespace", namespace, ...args], input)
}
const ns = JSON.parse(run("kubectl", [...flags, "get", "namespace", namespace, "-o", "json"]))
assert.equal(ns.metadata.labels["ate.dev/api-access"], "true")
const existing = JSON.parse(kubectl(["get", "pods", "-o", "json"]))
assert(
  !existing.items.some((item) => pods.some(([name]) => item.metadata.name === name)),
  "Refuse to replace existing identity Pods",
)
for (const sa of new Set(pods.map(([, sa]) => sa))) {
  kubectl(["get", "serviceaccount", sa, "-o", "name"])
}

run("docker", [
  "build",
  "--file",
  "tests/identity/Dockerfile",
  "--tag",
  "localhost:25071/substrate-identity:94e0a26a",
  ".",
])
run("docker", ["push", "localhost:25071/substrate-identity:94e0a26a"])
const image = run("docker", [
  "image",
  "inspect",
  "--format",
  "{{index .RepoDigests 0}}",
  "localhost:25071/substrate-identity:94e0a26a",
])
  .toString()
  .trim()
assert.match(image, /^localhost:25071\/substrate-identity@sha256:[0-9a-f]{64}$/)
writeFileSync(`${state}/image.txt`, `${image}\n`)
console.log(`Identity test image: ${image}`)

const manifest = {
  apiVersion: "v1",
  kind: "List",
  items: pods.map(([name, sa]) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace, labels: { "app.kubernetes.io/name": "substrate-identity-test" } },
    spec: {
      serviceAccountName: sa,
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
          name: "identity",
          image,
          resources: {
            requests: { cpu: "10m", memory: "64Mi" },
            limits: { cpu: "500m", memory: "256Mi" },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [
            { name: "identity", mountPath: "/var/run/ate", readOnly: true },
            { name: "scratch", mountPath: "/tmp" },
          ],
        },
      ],
      volumes: [
        { name: "scratch", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
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
              {
                serviceAccountToken: {
                  audience: "api.ate-system.svc",
                  expirationSeconds: 600,
                  path: "api-token",
                },
              },
              {
                serviceAccountToken: {
                  audience: "https://kubernetes.default.svc",
                  expirationSeconds: 600,
                  path: "wrong-audience",
                },
              },
            ],
          },
        },
      ],
    },
  })),
}
writeFileSync(`${state}/pods.json`, JSON.stringify(manifest, null, 2))
let admitted = false
try {
  admitted = true
  kubectl(["apply", "-f", "-"], JSON.stringify(manifest))
  kubectl([
    "wait",
    "--for=condition=Ready",
    ...pods.map(([name]) => `pod/${name}`),
    "--timeout=180s",
  ])
  kubectl([
    "exec",
    "identity-gateway",
    "--",
    "node",
    "-e",
    "require('node:fs').mkdirSync('/tmp/identity-runtime', { mode: 0o700 })",
  ])
  // Transfer only short-lived test credentials through process memory/stdin.
  // No private key or token is logged, put in argv, or saved on the host.
  for (const [pod, source, destination] of [
    ["identity-gateway-renewal", "api-token", "renewed-token"],
    ["identity-gateway-renewal", "credential-bundle.pem", "renewed-bundle"],
    ["identity-provisioner", "credential-bundle.pem", "provisioner-bundle"],
    ["identity-ungranted", "api-token", "ungranted-token"],
    ["identity-ungranted", "credential-bundle.pem", "ungranted-bundle"],
  ]) {
    const credential = kubectl([
      "exec",
      pod,
      "--",
      "node",
      "-e",
      `process.stdout.write(require('node:fs').readFileSync('/var/run/ate/${source}'))`,
    ])
    kubectl(
      [
        "exec",
        "-i",
        "identity-gateway",
        "--",
        "node",
        "-e",
        `require('node:fs').writeFileSync('/tmp/identity-runtime/${destination}', require('node:fs').readFileSync(0), { mode: 0o600 })`,
      ],
      credential,
    )
  }
  const output = kubectl([
    "exec",
    "identity-gateway",
    "--",
    "node",
    "build/tests/substrate-identity.js",
    "--task3-ready",
  ])
  writeFileSync(`${state}/runtime.log`, output)
  process.stdout.write(output)
} catch (error) {
  if (error.stdout) {
    writeFileSync(`${state}/runtime.log`, error.stdout)
    process.stdout.write(error.stdout)
  }
  if (error.stderr) process.stderr.write(error.stderr)
  process.exitCode = 1
  console.error(
    "Identity runtime failed; inspect .cache/identity/runtime.log. Do not replace this failure with unit evidence.",
  )
} finally {
  if (admitted)
    kubectl([
      "delete",
      "pod",
      ...pods.map(([name]) => name),
      "--ignore-not-found",
      "--wait=true",
      "--timeout=60s",
    ])
}
