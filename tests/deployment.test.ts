import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parse, parseAllDocuments, stringify } from "yaml"
import { buildActorEgressPolicy, buildActorTemplate } from "../src/substrate/provision.js"

const root = resolve(import.meta.dirname, "..")
const helm = resolve(root, ".cache/tools/helm")
const chart = resolve(root, "charts/telegram-pi")
const values = parse(readFileSync(resolve(chart, "values-kind.yaml"), "utf8"))
const decode = (text: string) =>
  parseAllDocuments(text)
    .map((doc) => {
      if (doc.errors.length) throw doc.errors[0]
      return doc.toJS()
    })
    .filter(Boolean)
function render(overrides: string[] = []) {
  return execFileSync(
    helm,
    [
      "template",
      "telegram-pi",
      chart,
      "--namespace",
      "telegram-pi",
      "-f",
      resolve(chart, "values-kind.yaml"),
      "-f",
      resolve(root, "tests/deployment/render-values.yaml"),
      ...overrides,
    ],
    { encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] },
  )
}
const platform = () =>
  decode(
    execFileSync(
      "kubectl",
      [
        "--kubeconfig",
        resolve(root, ".cache/kind/kubeconfig"),
        "--context",
        "kind-telegram-pi-validation",
        "kustomize",
        resolve(root, "deploy/platform"),
      ],
      { encoding: "utf8", timeout: 300_000 },
    ),
  )
const resource = (text: string, kind: string, name?: string) => {
  const result = decode(text).find((o) => o.kind === kind && (!name || o.metadata.name === name))
  if (!result) throw new Error(`Missing ${kind}/${name ?? "*"}`)
  return result
}
const envMap = (env: { name: string; value?: string; valueFrom?: unknown }[]) =>
  Object.fromEntries(env.map((entry) => [entry.name, entry.value ?? entry.valueFrom]))
const templateConfig = () => ({
  atespace: values.substrate.atespace,
  name: values.substrate.actorTemplate,
  image: values.images.actor,
  openAIBaseUrl: values.openai.baseUrl,
  openAIModel: values.openai.model,
  openAIModelMetadata: values.openai.modelMetadata,
  workerPoolLabel: "telegram-pi",
})

describe("deployment packaging", () => {
  it("has one Recreate poller without an application exposure or runtime Actor CRD", () => {
    const text = render()
    const objects = decode(text)
    const gateway = resource(text, "Deployment")
    expect(objects.filter((o) => o.kind === "Deployment")).toHaveLength(1)
    expect(resource(text, "NetworkPolicy", "telegram-pi-api").spec.egress[0].ports).toEqual([
      { protocol: "TCP", port: 443 },
    ])
    expect(gateway.spec.replicas).toBe(1)
    expect(gateway.spec.strategy).toEqual({ type: "Recreate" })
    expect(
      objects.some((o) =>
        [
          "Ingress",
          "Service",
          "Secret",
          "Actor",
          "ActorTemplate",
          "CustomResourceDefinition",
        ].includes(o.kind),
      ),
    ).toBe(false)
    expect(gateway.spec.template.spec.containers[0].command).toEqual([
      "node",
      "dist/gateway/index.js",
    ])
    expect(gateway.spec.template.spec.containers[0].readinessProbe.httpGet).toEqual({
      path: "/readyz",
      port: "health",
    })
  })

  it("orders workers, owner migration, ready template, then Gateway", () => {
    const text = render()
    const objects = decode(text)
    const jobs = objects.filter((o) => o.kind === "Job")
    const migration = jobs.find((o) => o.metadata.name.startsWith("telegram-pi-migrate-"))
    const provision = jobs.find((o) => o.metadata.name.startsWith("telegram-pi-provision-"))
    const wave = (o: { metadata: { annotations: Record<string, string> } }) =>
      Number(o.metadata.annotations["argocd.argoproj.io/sync-wave"])
    expect(wave(resource(text, "WorkerPool"))).toBeLessThan(wave(migration))
    expect(wave(migration)).toBeLessThan(wave(provision))
    expect(wave(provision)).toBeLessThan(wave(resource(text, "Deployment")))
    expect(jobs).toHaveLength(2)
    expect(migration.spec.template.spec.containers[0].command).toEqual([
      "node",
      "dist/gateway/migrate.js",
    ])
    expect(provision.spec.template.spec.containers[0].command).toEqual([
      "node",
      "dist/substrate/provision.js",
    ])
    expect(
      jobs.every((o) => !o.spec.ttlSecondsAfterFinished && !o.metadata.annotations["helm.sh/hook"]),
    ).toBe(true)
    const changed = decode(render(["--set-string", "openai.model=another-deployment"]))
    expect(changed.filter((o) => o.kind === "Job").map((o) => o.metadata.name)).not.toEqual(
      jobs.map((o) => o.metadata.name),
    )
  })

  it("uses only existing Secret references and separates database roles", () => {
    const text = render()
    const objects = decode(text)
    const gateway = resource(text, "Deployment").spec.template.spec
    const jobs = objects.filter((o) => o.kind === "Job")
    const migration = jobs.find((o) => o.metadata.name.startsWith("telegram-pi-migrate-")).spec
      .template.spec
    const provision = jobs.find((o) => o.metadata.name.startsWith("telegram-pi-provision-")).spec
      .template.spec
    const gatewayEnv = envMap(gateway.containers[0].env)
    const migrationEnv = envMap(migration.containers[0].env)
    expect(gatewayEnv.DATABASE_URL).toEqual({
      secretKeyRef: { name: "telegram-pi-database-app", key: "url" },
    })
    expect(migrationEnv.DATABASE_URL).toEqual({
      secretKeyRef: { name: "telegram-pi-database-owner", key: "url" },
    })
    expect(migrationEnv.DATABASE_APPLICATION_ROLE).toBe("telegram_pi_gateway")
    expect(gatewayEnv.TELEGRAM_TOKEN_FILE).toBe("/var/run/telegram/token")
    expect(gatewayEnv.TELEGRAM_ALLOWED_USER_IDS).toBe("102825484")
    expect(gatewayEnv.OPENAI_API_KEY).toBe("substrate-egress-placeholder")
    expect(gatewayEnv.MAX_ACTIVE_DISPATCH).toBe("2")
    expect(envMap(provision.containers[0].env)).not.toHaveProperty("DATABASE_URL")
    expect(
      new Set([
        gateway.serviceAccountName,
        migration.serviceAccountName,
        provision.serviceAccountName,
      ]).size,
    ).toBe(3)
    for (const pod of [gateway, migration, provision]) {
      expect(pod.automountServiceAccountToken).toBe(false)
      expect(pod.securityContext.runAsNonRoot).toBe(true)
      expect(pod.containers[0].securityContext.readOnlyRootFilesystem).toBe(true)
    }
    expect(objects.some((o) => ["ClusterRole", "ClusterRoleBinding"].includes(o.kind))).toBe(false)
    const role = resource(text, "Role", "telegram-pi-worker-capacity")
    expect(role.rules).toEqual([
      {
        apiGroups: ["ate.dev"],
        resources: ["workerpools"],
        resourceNames: ["telegram-pi"],
        verbs: ["get"],
      },
    ])
    const binding = resource(text, "RoleBinding", "telegram-pi-worker-capacity")
    expect(binding.subjects).toEqual([
      { kind: "ServiceAccount", name: "gateway", namespace: "telegram-pi" },
    ])
    expect(binding.roleRef).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: role.metadata.name,
    })
    expect(
      gateway.volumes.find((v: { name: string }) => v.name === "worker-capacity-identity").projected
        .sources,
    ).toEqual([
      { serviceAccountToken: { path: "token", expirationSeconds: 3600 } },
      { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
    ])
    expect(text).not.toMatch(
      /substrate-bootstrap|operator-token|AZURE_|fixture-injected-openai-key|rustfsadmin|NODE_TLS_REJECT_UNAUTHORIZED/,
    )
  })

  it("matches Secret data keys to .env names without mounting model credentials", () => {
    const defaults = parse(readFileSync(resolve(chart, "values.yaml"), "utf8"))
    expect(defaults.existingSecrets.telegram.key).toBe("BOT_TOKEN")
    expect(values.existingSecrets.telegram.key).toBe("BOT_TOKEN")
    const objects = decode(render())
    const gateway = objects.find((o) => o.kind === "Deployment").spec.template.spec
    const botSecret = gateway.volumes.find((v: { name: string }) => v.name === "telegram-token")
      .projected.sources
    expect(botSecret).toEqual([
      { secret: { name: "telegram-bot", items: [{ key: "BOT_TOKEN", path: "token" }] } },
    ])
    const uri = "ate-secret://k8s.io/default/telegram-pi-llm/openai-fixture/OPENAI_API_KEY"
    expect(values.openai.credentialUri).toBe(uri)
    for (const object of objects.filter((o) => ["Deployment", "Job"].includes(o.kind))) {
      const pod = object.spec.template.spec
      if (pod.serviceAccountName === "migration") continue
      const env = envMap(pod.containers[0].env)
      expect(env.LLM_CREDENTIAL_URI).toBe(uri)
      expect(env.OPENAI_API_KEY).toBe("substrate-egress-placeholder")
    }
    const llm = resource(
      readFileSync(resolve(root, "tests/kind/actor-credential-provider.yaml"), "utf8"),
      "Secret",
      "openai-fixture",
    )
    expect(Object.keys(llm.stringData)).toEqual(["OPENAI_API_KEY"])
    const client = resource(
      readFileSync(resolve(root, "tests/kind/actor-client.yaml.tmpl"), "utf8"),
      "Pod",
    )
    expect(envMap(client.spec.containers[0].env).ACTOR_CREDENTIAL_URI).toBe(uri)
  })

  it("projects live service-DNS trust and ECDSAP256 Pod identity without subPath", () => {
    const text = render()
    expect(resource(text, "Namespace").metadata.labels["ate.dev/api-access"]).toBe("true")
    for (const o of decode(text).filter((o) => ["Deployment", "Job"].includes(o.kind))) {
      const pod = o.spec.template.spec
      if (pod.serviceAccountName === "migration") continue
      const projection = pod.volumes.find(
        (v: { name: string }) => v.name === "ate-identity",
      ).projected
      expect(projection.sources).toEqual([
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
      ])
      expect(pod.containers[0].volumeMounts.every((v: { subPath?: string }) => !v.subPath)).toBe(
        true,
      )
      expect(envMap(pod.containers[0].env).SUBSTRATE_CA_FILE).toBe("/var/run/ate/ca.crt")
      expect(envMap(pod.containers[0].env).SUBSTRATE_CREDENTIAL_BUNDLE).toBe(
        "/var/run/ate/credential-bundle.pem",
      )
    }
  })

  it("uses two digest-pinned gVisor workers distinct from the Actor image", () => {
    const worker = resource(render(), "WorkerPool")
    expect(worker.spec.replicas).toBe(2)
    expect(worker.spec.sandboxClasses).toEqual([
      { name: "gvisor", configRef: { name: "gvisor-default" } },
    ])
    expect(worker.metadata.labels.workload).toBe("telegram-pi")
    expect(worker.spec.workerImage).toMatch(/@sha256:[a-f0-9]{64}$/)
    expect(worker.spec.workerImage).not.toBe(values.images.actor)
    const template = buildActorTemplate(templateConfig())
    expect(values.substrate.actorTemplate).toBe("pi-v3-kind")
    expect(values.openai.model).toBe("gpt-5.6-luna")
    expect(values.openai.modelMetadata).toBe("gpt-5.6-luna")
    expect(envMap(template.containers[0].env)).toMatchObject({
      OPENAI_MODEL: "gpt-5.6-luna",
      OPENAI_MODEL_METADATA: "gpt-5.6-luna",
    })
    expect(template.containers[0].image).toBe(values.images.actor)
    expect(template.workerSelector?.matchLabels).toEqual({ workload: "telegram-pi" })
    expect(template.containers[0].env.find((e) => e.name === "OPENAI_API_KEY")?.value).toBe(
      "substrate-egress-placeholder",
    )
    expect(template.volumes.find((v) => v.name === "data")?.durableDir).toBeDefined()
    expect(template.containers[0].env.map((entry) => entry.name).sort()).toEqual([
      "GIT_SSL_CAINFO",
      "NODE_EXTRA_CA_CERTS",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_MODEL",
      "OPENAI_MODEL_METADATA",
      "SSL_CERT_FILE",
    ])
    expect(template.volumes.map((volume) => volume.name).sort()).toEqual([
      "data",
      "egress-trust",
      "identity",
    ])
  })

  it("injects credentials only on exact LLM hosts, never development hosts", () => {
    const policy = buildActorEgressPolicy(values.substrate.atespace, {
      openAIBaseUrl: values.openai.baseUrl,
      llmCredentialUri: values.openai.credentialUri,
      developmentHosts: values.developmentHosts,
    })
    expect(policy.rules).toHaveLength(2)
    expect(policy.rules[0].https?.hostnames).toEqual([
      "synthetic-api.telegram-pi-fixtures.svc",
      "synthetic-api.telegram-pi-fixtures.svc.cluster.local",
    ])
    expect(policy.rules[0].https?.effects?.replaceHeaders).toEqual([
      { header: "Authorization", prefix: "Bearer ", credentialUri: values.openai.credentialUri },
    ])
    expect(policy.rules[1].https?.effects).toBeUndefined()
    expect(policy.rules[1].https?.hostnames).toEqual([
      "development-api.telegram-pi-fixtures.svc",
      "development-api.telegram-pi-fixtures.svc.cluster.local",
    ])
    expect(stringify(policy)).not.toContain("*")
  })

  it.each([
    ["images.actor=registry.invalid/actor:latest"],
    [`images.worker=${values.images.actor}`],
    ["openai.baseUrl=http://model.invalid/v1"],
    ["openai.credentialUri=inline-api-key"],
    ["developmentHosts[0]=*.example.invalid"],
    ["telegram.allowedUserIds[0]=0"],
    ["openai.apiKey=forbidden"],
    ["telegram.token=forbidden"],
    ["replicas=2"],
    ["ingress.enabled=true"],
    ["kubernetesApi.cidr=0.0.0.0/0"],
    ["kubernetesApi.port=0"],
    ["existingSecrets.database.name=telegram-pi-database-owner"],
  ])("rejects unsafe or unsupported values %s", (settings) => {
    expect(() => render(["--set-string", settings])).toThrow()
  })

  it("retains source-pinned platform, fixture trust and narrowed provider access", () => {
    const objects = platform()
    expect(objects.some((o) => o.kind === "Secret")).toBe(false)
    expect(
      objects.some(
        (o) =>
          o.kind === "ClusterRoleBinding" &&
          o.metadata.name === "k8s-credential-provider-secret-reader",
      ),
    ).toBe(false)
    const role = objects.find(
      (o) => o.kind === "Role" && o.metadata.name === "telegram-pi-llm-reader",
    )
    expect(role.rules).toEqual([
      {
        apiGroups: [""],
        resources: ["secrets"],
        resourceNames: ["openai-fixture"],
        verbs: ["get"],
      },
    ])
    const providerPolicy = objects.find(
      (o) =>
        o.kind === "ConfigMap" && o.metadata.name === "k8s-credential-provider-namespace-policy",
    )
    for (const policy of parse(providerPolicy.data["namespace-policy.yaml"]).policies) {
      expect(policy.allowedNamespaces).toEqual(["telegram-pi-llm"])
      expect(policy.secretSelector).toEqual({ matchLabels: { "telegram-pi/credential": "llm" } })
    }
    const egress = objects.find(
      (o) => o.kind === "Deployment" && o.metadata.name === "atenet-egress",
    )
    expect(
      egress.spec.template.spec.initContainers.some(
        (c: { name: string }) => c.name === "e2e-egress-upstream-roots",
      ),
    ).toBe(true)
    expect(
      readFileSync(resolve(root, "deploy/platform/fixture-upstream-roots.patch.yaml"), "utf8"),
    ).toBe(readFileSync(resolve(root, "tests/fixtures/egress-upstream-roots.patch.yaml"), "utf8"))
    const lock = JSON.parse(readFileSync(resolve(root, "deploy/platform/images.lock.json"), "utf8"))
    expect(lock.revision).toBe("94e0a26ac90151886a76410568aaac2664a54d90")
    const api = objects.find((o) => o.kind === "Deployment" && o.metadata.name === "ate-api-server")
    expect(
      api.spec.template.spec.containers.find((c: { name: string }) => c.name === "ate-api-server")
        .args,
    ).toContain("--authz-bootstrap-owners=system:serviceaccount:ate-system:substrate-bootstrap")
    const idp = objects.find((o) => o.kind === "Deployment" && o.metadata.name === "ate-idp-server")
    expect(idp.spec.template.spec.containers[0].args).toContain(
      "--issuer=https://idp.ate-system.svc",
    )
    const plugin = api.spec.template.spec.initContainers.find(
      (c: { name: string }) => c.name === "objectstore-plugin",
    )
    expect(envMap(plugin.env).AWS_SECRET_ACCESS_KEY).toEqual({
      secretKeyRef: { name: "rustfs-credentials", key: "secret-key" },
    })
    expect(stringify(objects)).not.toMatch(
      /rustfsadmin|ko:\/\/|\$\{ENVOY_DATAPLANE_IMAGE\}|fixture-injected-openai-key/,
    )
  })

  it("keeps separate scoped Argo Applications without automated prune or secret ownership", () => {
    const applications = decode(
      readFileSync(resolve(root, "deploy/argocd/applications.yaml"), "utf8"),
    )
    expect(applications.map((o) => o.metadata.name)).toEqual(["substrate-platform", "telegram-pi"])
    expect(applications.map((o) => o.spec.source.path)).toEqual([
      "deploy/platform",
      "charts/telegram-pi",
    ])
    for (const app of applications) {
      expect(app.spec.syncPolicy.automated).toBeUndefined()
      expect(app.metadata.finalizers).toBeUndefined()
      expect(app.spec.source.targetRevision).not.toMatch(/^(HEAD|main|master)$/)
    }
    const projects = decode(readFileSync(resolve(root, "deploy/argocd/projects.yaml"), "utf8"))
    for (const project of projects) {
      expect(
        project.spec.namespaceResourceWhitelist.some((entry: { kind: string }) =>
          ["Secret", "Actor", "ActorTemplate", "*"].includes(entry.kind),
        ),
      ).toBe(false)
    }
    const health = parse(readFileSync(resolve(root, "deploy/argocd/health.yaml"), "utf8"))
    expect(health.data["resource.customizations.health.ate.dev_WorkerPool"]).toContain(
      "obj.status.readyReplicas ~= obj.spec.replicas",
    )
  })
})
