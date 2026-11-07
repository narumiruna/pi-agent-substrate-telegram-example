// Reproduce the retained, post-bootstrap kind boundary. Never read cluster Secrets.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseAllDocuments, stringify } from "yaml"

const root = fileURLToPath(new URL("../../", import.meta.url))
const source = resolve(root, ".cache/substrate")
const destination = resolve(root, "deploy/platform")
const lock = JSON.parse(readFileSync(resolve(destination, "images.lock.json")))
const check = process.argv.includes("--check")
const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, encoding: "utf8", timeout: 300_000 })
if (run("git", ["rev-parse", "HEAD"], source).trim() !== lock.revision) {
  throw new Error("Substrate revision differs from reviewed pin")
}
if (
  run("git", ["status", "--porcelain", "--untracked-files=all"], source).trim() !==
  "M manifests/ate-install/kind/atelet/kustomization.yaml"
) {
  throw new Error("Only the reviewed kind registry patch is permitted")
}
const hash = (text) => createHash("sha256").update(text).digest("hex")
const registryPath = "manifests/ate-install/kind/atelet/kustomization.yaml"
if (
  hash(readFileSync(resolve(source, registryPath))) !==
  "5e8ce821431d0bb7e44d2f79ecd71bcc9792a68230be6804400275a1dbfb5363"
) {
  throw new Error("Registry patch differs from reviewed content")
}
const inputs = {}
const read = (path) => {
  const bytes = readFileSync(resolve(source, path))
  inputs[path] = hash(bytes)
  return bytes.toString()
}
const documents = (text) =>
  parseAllDocuments(text)
    .map((doc) => {
      if (doc.errors.length) throw doc.errors[0]
      return doc.toJS()
    })
    .filter(Boolean)
const build = (path) =>
  documents(
    run("kubectl", [
      "--kubeconfig",
      resolve(root, ".cache/kind/kubeconfig"),
      "--context",
      "kind-telegram-pi-validation",
      "kustomize",
      "--load-restrictor=LoadRestrictionsNone",
      resolve(source, path),
    ]),
  )
const keep = (objects) =>
  objects.filter((o) => {
    if (o.kind === "Secret") throw new Error("No Secret may enter the platform boundary")
    return !(o.kind === "ServiceAccount" && o.metadata.name === "ate-client") && o.kind !== "Job"
  })
function transform(objects) {
  for (const o of objects) {
    let wave = "0"
    if (["Namespace", "CustomResourceDefinition"].includes(o.kind)) wave = "-10"
    else if (
      ["ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"].includes(
        o.kind,
      )
    )
      wave = "-9"
    else if (
      [
        "ConfigMap",
        "Service",
        "PersistentVolumeClaim",
        "NetworkPolicy",
        "ResourceQuota",
        "ValidatingAdmissionPolicy",
        "ValidatingAdmissionPolicyBinding",
      ].includes(o.kind)
    )
      wave = "-8"
    else if (o.kind === "SandboxConfig") wave = "-7"
    o.metadata.annotations = {
      ...o.metadata.annotations,
      "argocd.argoproj.io/sync-wave": wave,
      "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
    }
    const pod = o.spec?.template?.spec
    if (!pod) continue
    for (const c of [...(pod.initContainers ?? []), ...(pod.containers ?? [])]) {
      c.image = lock.images[c.image] ?? c.image
      if (!/@sha256:[a-f0-9]{64}$/.test(c.image)) throw new Error(`Unpinned image: ${c.image}`)
      for (const env of c.env ?? []) {
        const key = {
          AWS_ACCESS_KEY_ID: "access-key",
          RUSTFS_ACCESS_KEY: "access-key",
          AWS_SECRET_ACCESS_KEY: "secret-key",
          RUSTFS_SECRET_KEY: "secret-key",
        }[env.name]
        if (key) {
          // Explicit null removes the upstream installer's literal value on adoption.
          env.value = null
          env.valueFrom = { secretKeyRef: { name: "rustfs-credentials", key } }
        }
      }
    }
    if (o.metadata.name === "atenet-router") {
      pod.containers
        .find((c) => c.name === "atenet-router")
        .args.push("--ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/telegram-pi/sa/gateway")
    }
  }
  return objects
}
function output(name, text) {
  const path = resolve(destination, name)
  if (check) {
    if (readFileSync(path, "utf8") !== text) throw new Error(`Stale platform artifact: ${name}`)
  } else {
    mkdirSync(resolve(path, ".."), { recursive: true })
    writeFileSync(path, text)
  }
}
function manifest(name, objects) {
  const header =
    "# Derived from Agent Substrate 94e0a26ac90151886a76410568aaac2664a54d90.\n# Modified post-bootstrap kind boundary; see ../PROVENANCE.md and ../LICENSE.\n"
  output(
    `vendor/${name}.yaml`,
    header +
      transform(keep(objects))
        .map((o) => stringify(o, { lineWidth: 0 }))
        .join("---\n"),
  )
}
manifest("system", build("manifests/ate-install/kind"))
manifest("postgres", build("manifests/ate-install/kind/postgres"))
manifest("signer", documents(read("manifests/ate-install/pod-certificate-controller.yaml")))
manifest("infrastructure", [
  ...[
    "ate.dev_workerpools.yaml",
    "ate.dev_sandboxconfigs.yaml",
    "ate.dev_csidriverconfigs.yaml",
    "role.yaml",
  ].flatMap((file) => documents(read(`manifests/ate-install/generated/${file}`))),
  ...documents(read("manifests/ate-install/sandboxconfig-validation.yaml")),
  ...documents(read("manifests/ate-install/sandboxconfig-gvisor.yaml")),
])
const egress = read("manifests/ate-install/atenet-egress.yaml").replace(
  /^ {8}#ATE_EGRESS_INJECT_FLAGS.*$/m,
  [
    "--credential-provider-name=k8s.io",
    "--credential-provider-address=k8s-credential-provider.ate-system.svc:50051",
    "--credential-provider-server-name=k8s-credential-provider.ate-system.svc",
    "--credential-provider-ca-file=/run/servicedns.podcert.ate.dev/trust-bundle.pem",
    "--credential-provider-client-cert=/run/podidentity.podcert.ate.dev/credential-bundle.pem",
  ]
    .map((arg) => `        - ${arg}`)
    .join("\n"),
)
if (egress.includes("#ATE_EGRESS_INJECT_FLAGS"))
  throw new Error("Credential-provider marker was not resolved")
manifest("egress", documents(egress))
manifest(
  "credential-provider",
  documents(read("manifests/egress-credential-injection/k8s-credential-provider.yaml")).filter(
    (o) => !["ClusterRole", "ClusterRoleBinding"].includes(o.kind),
  ),
)
output("LICENSE", read("LICENSE"))
// Record every file the upstream Kustomize bundles can reference. Source bytes
// are hashed, not cluster resources; no private bootstrap configuration is read.
for (const path of run("git", ["ls-files", "manifests/ate-install"], source).trim().split("\n")) {
  if (path.endsWith(".yaml")) read(path)
}
output(
  "source.sha256",
  Object.entries(inputs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, sum]) => `${sum}  ${path}\n`)
    .join(""),
)
console.log(check ? "Pinned platform reproduction passed" : "Pinned platform artifacts written")
