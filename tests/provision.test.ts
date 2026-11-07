import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { status } from "@grpc/grpc-js"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { actorNameForConversation } from "../src/gateway/store.js"
import {
  ActorMetadataField,
  SnapshotFidelity,
  SnapshotStorageState,
} from "../src/substrate/generated/ateapi/v1/ateapi.js"
import {
  buildActorEgressPolicy,
  buildActorTemplate,
  type ConversationActorConfig,
  ensureActor,
  ensureTemplate,
} from "../src/substrate/provision.js"
import { tlsFixture } from "./identity/tls-fixture.js"
import { egressConfig, fakeControl, templateConfig, waitOptions } from "./provision/fake.js"

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture field is absent")
  return value
}

const actorConfig: ConversationActorConfig = {
  atespace: templateConfig.atespace,
  name: actorNameForConversation("telegram:123:-456:main"),
  template: { atespace: templateConfig.atespace, name: templateConfig.name },
  egress: egressConfig,
}

describe("Actor template and egress configuration", () => {
  it("builds only the workload image, durable data, fresh identity, and trust projections", () => {
    const template = buildActorTemplate(templateConfig)
    const container = template.containers[0]
    expect(template.workerSelector?.matchLabels).toEqual({ workload: "telegram-pi" })
    expect(template.snapshotConfig?.preferredFidelity).toBe(
      SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY,
    )
    expect(template.goldenEgressPolicy).toBeUndefined()
    expect(template.resources?.limits).toEqual({ cpuMillicores: 1000n, memoryBytes: 536870912n })
    expect(container.image).toBe(templateConfig.image)
    expect(container.command).toEqual(["node", "/app/dist/actor/index.js"])
    expect(container.wakeupProbe).toEqual({
      httpGet: { path: "/healthz", port: 80 },
      timeoutSeconds: 30,
    })
    expect(container.volumeMounts).toEqual([
      { name: "data", mountPath: "/data" },
      { name: "identity", mountPath: "/run/ate/identity" },
      { name: "egress-trust", mountPath: "/run/ate/egress-trust-bundle" },
    ])
    expect(
      template.volumes.filter((volume) => volume.durableDir).map((volume) => volume.name),
    ).toEqual(["data"])
    expect(template.volumes.flatMap((volume) => volume.systemInfo?.dataSources ?? [])).toEqual([
      {
        actorMetadata: {
          items: [
            { field: ActorMetadataField.ACTOR_METADATA_FIELD_NAME, path: "actor-name" },
            { field: ActorMetadataField.ACTOR_METADATA_FIELD_ATESPACE, path: "atespace" },
            { field: ActorMetadataField.ACTOR_METADATA_FIELD_UID, path: "actor-uid" },
          ],
        },
        trustBundle: undefined,
      },
      {
        actorMetadata: undefined,
        trustBundle: {
          names: ["egress-mitm.ate.dev", "system-roots.ate.dev"],
          path: "trust-bundle.pem",
        },
      },
    ])
    const env = Object.fromEntries(container.env.map(({ name, value }) => [name, value]))
    expect(env).toEqual({
      OPENAI_BASE_URL: templateConfig.openAIBaseUrl,
      OPENAI_MODEL: "test-deployment",
      OPENAI_MODEL_METADATA: "gpt-4.1-mini",
      OPENAI_API_KEY: "substrate-egress-placeholder",
      NODE_EXTRA_CA_CERTS: "/run/ate/egress-trust-bundle/trust-bundle.pem",
      SSL_CERT_FILE: "/run/ate/egress-trust-bundle/trust-bundle.pem",
      GIT_SSL_CAINFO: "/run/ate/egress-trust-bundle/trust-bundle.pem",
    })
    expect(
      buildActorTemplate({ ...templateConfig, workerPoolLabel: "other-bot" }).workerSelector
        ?.matchLabels,
    ).toEqual({ workload: "other-bot" })
    expect(template.volumes.every((volume) => !volume.external && !volume.image)).toBe(true)
  })

  it("limits credential replacement to the exact HTTPS LLM destination and port", () => {
    const policy = buildActorEgressPolicy("telegram-pi", egressConfig)
    expect(policy.metadata?.name).toBe("default")
    expect(policy.rules[0].https).toEqual({
      hostnames: ["llm.example.test"],
      ports: { numbers: [8443], all: undefined },
      effects: {
        replaceHeaders: [
          {
            header: "Authorization",
            prefix: "Bearer ",
            credentialUri: egressConfig.llmCredentialUri,
            actorJwt: undefined,
          },
        ],
      },
    })
    expect(policy.rules.slice(1).map((rule) => rule.https?.hostnames)).toEqual([
      ["github.com"],
      ["registry.npmjs.org"],
    ])
    expect(
      policy.rules
        .slice(1)
        .every((rule) => !rule.https?.effects && rule.https?.ports?.numbers[0] === 443),
    ).toBe(true)
    expect(policy.rules.every((rule) => !rule.http && !rule.tlsPassthrough)).toBe(true)
    expect(
      buildActorEgressPolicy("telegram-pi", { ...egressConfig, developmentHosts: [] }).rules,
    ).toHaveLength(1)
  })

  it.each(["", "Upper", "-bad", "bad-", "bad.name", "a".repeat(64), "bad\nname"])(
    "rejects invalid names %j",
    (name) => {
      expect(() => buildActorTemplate({ ...templateConfig, name })).toThrow(/DNS label/)
      expect(() => buildActorTemplate({ ...templateConfig, atespace: name })).toThrow(/DNS label/)
      expect(() => buildActorTemplate({ ...templateConfig, workerPoolLabel: name })).toThrow(
        /DNS label/,
      )
    },
  )
  it.each([
    "pi:latest",
    `pi@sha256:${"a".repeat(63)}`,
    `Pi@sha256:${"a".repeat(64)}`,
    `registry.test//pi@sha256:${"a".repeat(64)}`,
    `https://registry.test/pi@sha256:${"a".repeat(64)}`,
    `registry.test:70000/pi@sha256:${"a".repeat(64)}`,
    `registry.test:443:444/pi@sha256:${"a".repeat(64)}`,
  ])("rejects invalid image %s", (image) => {
    expect(() => buildActorTemplate({ ...templateConfig, image })).toThrow()
  })
  it.each([
    "http://llm.example.test/v1",
    "https://user:pass@llm.example.test/v1",
    "https://llm.example.test/v1?key=secret",
    "https://llm.example.test/v1#bad",
    "https://*.example.test/v1",
    "https://127.0.0.1/v1",
    "https://LLM.example.test/v1",
    " https://llm.example.test",
    "https://llm.example.test:0",
    "https://llm.example.test:65536",
    "https://llm..test",
    "https://llm.example.test\\evil",
    "https://llm.example.test/v1\u0000",
  ])("rejects invalid LLM Base URL %s", (openAIBaseUrl) => {
    expect(() => buildActorTemplate({ ...templateConfig, openAIBaseUrl })).toThrow()
    expect(() =>
      buildActorEgressPolicy("telegram-pi", { ...egressConfig, openAIBaseUrl }),
    ).toThrow()
  })
  it.each([
    ["*.github.com"],
    ["https://github.com"],
    ["github.com:443"],
    ["github.com."],
    ["GITHUB.COM"],
    ["localhost"],
    ["github.com", "github.com"],
    ["llm.example.test"],
    [""],
  ])("rejects wildcard, malformed, duplicate, or colliding hosts %j", (...hosts) => {
    expect(() =>
      buildActorEgressPolicy("telegram-pi", { ...egressConfig, developmentHosts: hosts.flat() }),
    ).toThrow()
  })
  it.each([
    "secret-key",
    "ate-secret://k8s.io/default/ns/name/key?bad",
    "ate-secret://k8s.io/default/ns/name/..",
    "ate-secret://k8s.io/default/ns/name/",
    "ate-secret://other/default/ns/name/key",
  ])("rejects invalid credential URI %s", (llmCredentialUri) => {
    expect(() =>
      buildActorEgressPolicy("telegram-pi", { ...egressConfig, llmCredentialUri }),
    ).toThrow(/credential/i)
  })
  it("adds only exact Kubernetes .svc DNS expansions and keeps credentials separate", () => {
    const policy = buildActorEgressPolicy("telegram-pi", {
      ...egressConfig,
      openAIBaseUrl: "https://synthetic-api.telegram-pi-fixtures.svc/openai/v1",
      developmentHosts: ["packages.telegram-pi-fixtures.svc", "github.com"],
    })
    expect(policy.rules[0].https?.hostnames).toEqual([
      "synthetic-api.telegram-pi-fixtures.svc",
      "synthetic-api.telegram-pi-fixtures.svc.cluster.local",
    ])
    expect(policy.rules[2].https?.hostnames).toEqual([
      "packages.telegram-pi-fixtures.svc",
      "packages.telegram-pi-fixtures.svc.cluster.local",
    ])
    expect(policy.rules.slice(1).every((rule) => !rule.https?.effects)).toBe(true)
    for (const developmentHosts of [
      ["synthetic-api.telegram-pi-fixtures.svc.cluster.local"],
      ["packages.telegram-pi-fixtures.svc", "packages.telegram-pi-fixtures.svc.cluster.local"],
    ]) {
      expect(() =>
        buildActorEgressPolicy("telegram-pi", {
          ...egressConfig,
          openAIBaseUrl: "https://synthetic-api.telegram-pi-fixtures.svc/openai/v1",
          developmentHosts,
        }),
      ).toThrow(/collide/)
    }
    expect(buildActorEgressPolicy("telegram-pi", egressConfig).rules[0].https?.hostnames).toEqual([
      "llm.example.test",
    ])
  })

  it("rejects unknown metadata instead of waiting for golden success with a broken Actor", () => {
    expect(() =>
      buildActorTemplate({ ...templateConfig, openAIModelMetadata: "unknown-model" }),
    ).toThrow(/metadata/)
    expect(() => buildActorTemplate({ ...templateConfig, openAIModel: "" })).toThrow(/model/)
  })
})

describe("retry-safe provisioning through in-process mTLS gRPC", () => {
  let tls: ReturnType<typeof tlsFixture>
  let fake: Awaited<ReturnType<typeof fakeControl>>
  beforeAll(() => {
    tls = tlsFixture()
  })
  afterAll(() => {
    rmSync(tls.directory, { recursive: true, force: true })
  })
  beforeEach(async () => {
    fake = await fakeControl(tls)
  })
  afterEach(async () => {
    await fake.close()
  })
  const provision = () => ensureTemplate(fake.client, templateConfig, waitOptions)
  const create = (config = actorConfig) => ensureActor(fake.client, config, waitOptions)

  it("repeated and concurrent template calls keep one immutable record and remote receipt", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, provision))
    const repeated = await provision()
    expect(fake.templates.size).toBe(1)
    expect(fake.tags.size).toBe(1)
    expect(new Set([...results, repeated].map((ready) => ready.template.metadata?.uid)).size).toBe(
      1,
    )
    expect(repeated.resolvedImages).toEqual([templateConfig.image])
    expect(repeated.snapshot.durableSnapshot?.object?.snapshotUri).toMatch(
      /^gs:\/\/ate-snapshots\//,
    )
    expect(repeated.snapshot.durableSnapshot?.state).toBe(
      SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
    )
  })

  it.each(["template", "actor", "policy"] as const)(
    "reconciles a lost %s Create response without another record",
    async (kind) => {
      fake.lost.add(kind)
      await provision()
      const actor = await create()
      const retry = await create()
      expect(retry.metadata?.uid).toBe(actor.metadata?.uid)
      expect(fake.templates.size).toBe(1)
      expect(fake.actors.size).toBe(1)
      expect(fake.policies.size).toBe(1)
      const method =
        kind === "template" ? "ActorTemplate" : kind === "actor" ? "Actor" : "ActorEgressPolicy"
      const index = fake.calls.indexOf(`create${method}`)
      expect(fake.calls[index + 1]).toBe(`get${method}`)
    },
  )

  it.each(["template", "actor", "policy"] as const)(
    "retries named %s Create only after Get proves it absent",
    async (kind) => {
      fake.beforeCommit.add(kind)
      await provision()
      await create()
      expect(fake.templates.size).toBe(1)
      expect(fake.actors.size).toBe(1)
      expect(fake.policies.size).toBe(1)
    },
  )

  it("normalizes server metadata, defaults, and map/set order but not caller fields", async () => {
    await provision()
    const record = fake.template()
    record.metadata = {
      ...(record.metadata as NonNullable<typeof record.metadata>),
      version: 999n,
      updateTime: { seconds: 123n, nanos: 1 },
    }
    record.snapshotConfig = undefined
    record.containers[0].env.reverse()
    record.containers[0].volumeMounts.reverse()
    record.volumes.reverse()
    record.volumes[0].systemInfo?.dataSources[0].trustBundle?.names.reverse()
    await expect(provision()).resolves.toHaveProperty("goldenTag")
    record.containers[0].args = ["unexpected"]
    await expect(provision()).rejects.toThrow(/specification conflict/)
  })

  it.each(["image", "selector", "environment", "volumes", "resources", "goldenPolicy"])(
    "fails an immutable template %s conflict without mutation",
    async (field) => {
      await provision()
      const record = fake.template()
      if (field === "image") record.containers[0].image = `pi@sha256:${"b".repeat(64)}`
      if (field === "selector") record.workerSelector = { matchLabels: { workload: "other" } }
      if (field === "environment")
        record.containers[0].env.push({ name: "SECRET", value: "not-allowed" })
      if (field === "volumes") record.volumes.push({ ...record.volumes[0], name: "extra" })
      if (field === "resources" && record.resources?.limits)
        record.resources.limits.cpuMillicores = 2000n
      if (field === "goldenPolicy") record.goldenEgressPolicy = { rules: [] }
      await expect(provision()).rejects.toThrow(/specification conflict/)
      expect(fake.templates.size).toBe(1)
    },
  )

  it("does not accept Create as readiness and records actual lower snapshot fidelity", async () => {
    fake.state.goldenReady = false
    fake.state.pendingTag = true
    fake.state.onTemplateGet = () => {
      if (fake.state.reads === 3) {
        present(fake.template().status?.goldenSnapshotStatus).goldenTag = {
          atespace: templateConfig.atespace,
          name: present(fake.template().metadata).uid,
        }
      }
      if (fake.state.reads === 5) {
        const snapshot = present(fake.tag().status?.snapshot)
        present(snapshot.durableSnapshot).state =
          SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED
        snapshot.fidelity = SnapshotFidelity.SNAPSHOT_FIDELITY_VOLUMES
      }
    }
    const ready = await provision()
    expect(fake.state.reads).toBe(5)
    expect(ready.snapshot.fidelity).toBe(SnapshotFidelity.SNAPSHOT_FIDELITY_VOLUMES)
  })

  it("waits for a reserved tag without status instead of accepting it as ready", async () => {
    await provision()
    const saved = fake.tag().status
    fake.tag().status = undefined
    fake.state.onTemplateGet = () => {
      if (fake.state.reads >= 4) fake.tag().status = saved
    }
    await expect(provision()).resolves.toHaveProperty("snapshot")
    expect(fake.state.reads).toBeGreaterThanOrEqual(4)
  })

  it.each([false, true])(
    "accepts optional nested template UID only when empty or matching (%s)",
    async (populated) => {
      await provision()
      present(fake.tag().status?.snapshot).actorTemplateUid = populated
        ? present(fake.template().metadata).uid
        : ""
      await expect(provision()).resolves.toHaveProperty("snapshot")
    },
  )
  it("reports a terminal golden error", async () => {
    fake.state.goldenError = "WakeupFailed: process exited"
    await expect(provision()).rejects.toThrow(
      "Golden snapshot build failed: WakeupFailed: process exited",
    )
    expect(fake.calls.filter((call) => call === "createActor")).toHaveLength(0)
  })
  it.each(["golden", "pending", "missingTag", "hungRpc"])(
    "bounds %s readiness by one deadline",
    async (kind) => {
      await provision()
      if (kind === "golden")
        present(fake.template().status?.goldenSnapshotStatus).goldenTag = undefined
      if (kind === "pending")
        present(fake.tag().status?.snapshot?.durableSnapshot).state =
          SnapshotStorageState.SNAPSHOT_STORAGE_STATE_PENDING
      if (kind === "missingTag") fake.tags.clear()
      if (kind === "hungRpc") fake.state.hangTemplateGet = true
      await expect(
        ensureTemplate(fake.client, templateConfig, { timeoutMs: 50, pollIntervalMs: 2 }),
      ).rejects.toThrow(/deadline exceeded/)
      expect(fake.templates.size).toBe(1)
    },
  )
  it.each(["digest", "remoteUri", "templateUid", "snapshotUid", "fidelity"])(
    "rejects missing or mismatched %s in readiness",
    async (kind) => {
      await provision()
      const snapshot = present(fake.tag().status?.snapshot)
      if (kind === "digest") fake.template().containers[0].image = "pi:latest"
      if (kind === "remoteUri") present(snapshot.durableSnapshot?.object).snapshotUri = ""
      if (kind === "templateUid") present(fake.tag().status).actorTemplateUid = randomUUID()
      if (kind === "snapshotUid") snapshot.actorTemplateUid = randomUUID()
      if (kind === "fidelity") snapshot.fidelity = SnapshotFidelity.SNAPSHOT_FIDELITY_UNSPECIFIED
      await expect(create()).rejects.toThrow()
      expect(fake.actors.size).toBe(0)
    },
  )
  it("retries transient reads and supports cancellation without deleting records", async () => {
    fake.lost.add("template")
    fake.state.unavailableGets = 2
    await provision()
    present(fake.template().status?.goldenSnapshotStatus).goldenTag = undefined
    const controller = new AbortController()
    const pending = ensureTemplate(fake.client, templateConfig, {
      ...waitOptions,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(new Error("wait detached")), 15)
    await expect(pending).rejects.toThrow("wait detached")
    expect(fake.templates.size).toBe(1)
  })

  it("returns the stable mapped name and UID only after the default policy exists", async () => {
    await provision()
    let returned = false
    fake.state.onPolicyCreate = () => expect(returned).toBe(false)
    const actors = await Promise.all(Array.from({ length: 6 }, () => create()))
    returned = true
    expect(fake.policies.size).toBe(1)
    expect(fake.actors.size).toBe(1)
    expect(new Set(actors.map((actor) => actor.metadata?.uid)).size).toBe(1)
    expect(actors[0].metadata?.name).toBe(actorNameForConversation("telegram:123:-456:main"))
    expect(actors[0].sourceTag).toEqual(fake.template().status?.goldenSnapshotStatus?.goldenTag)
    expect(fake.calls.indexOf("createActorEgressPolicy")).toBeGreaterThan(
      fake.calls.indexOf("createActor"),
    )
    expect(fake.calls.every((method) => !/resume|delete|update/i.test(method))).toBe(true)
    const retried = await create({ ...actorConfig, expectedUid: actors[0].metadata?.uid })
    expect(retried.metadata?.uid).toBe(actors[0].metadata?.uid)
  })
  it.each(["template", "sourceTag", "selector"])(
    "refuses an existing Actor %s conflict",
    async (field) => {
      await provision()
      await create()
      if (field === "template")
        fake.actor().actorTemplate = { ...actorConfig.template, name: "other-v1" }
      if (field === "sourceTag") fake.actor().sourceTag = undefined
      if (field === "selector") fake.actor().workerSelector = { matchLabels: { workload: "other" } }
      await expect(create()).rejects.toThrow(/Actor specification conflict/)
    },
  )
  it("refuses policy conflict and does not treat policy failure as Actor readiness", async () => {
    await provision()
    fake.state.denyPolicy = true
    await expect(create()).rejects.toHaveProperty("code", status.PERMISSION_DENIED)
    expect(fake.actors.size).toBe(1)
    expect(fake.policies.size).toBe(0)
    fake.state.denyPolicy = false
    await create()
    present(fake.policy().rules[1].https).effects = fake.policy().rules[0].https?.effects
    await expect(create()).rejects.toThrow(/EgressPolicy specification conflict/)
  })
  it("compares policies independent of unordered rule/hostname/header case", async () => {
    await provision()
    await create()
    present(fake.policy().rules[0].https?.effects).replaceHeaders[0].header = "authorization"
    fake.policy().rules.reverse()
    await expect(create()).resolves.toHaveProperty("metadata.uid")
  })
  it("refuses missing or replaced UID mappings instead of creating replacement state", async () => {
    await provision()
    const actor = await create()
    await expect(create({ ...actorConfig, expectedUid: randomUUID() })).rejects.toThrow(
      /UID conflicts/,
    )
    fake.actors.clear()
    const calls = fake.calls.filter((call) => call === "createActor").length
    await expect(create({ ...actorConfig, expectedUid: actor.metadata?.uid })).rejects.toThrow(
      /automatic replacement is forbidden/,
    )
    expect(fake.calls.filter((call) => call === "createActor")).toHaveLength(calls)
  })
  it("checks Actor policy endpoint against its immutable template", async () => {
    await provision()
    await expect(
      create({
        ...actorConfig,
        egress: { ...egressConfig, openAIBaseUrl: "https://other.test/v1" },
      }),
    ).rejects.toThrow(/Base URL conflicts/)
    expect(fake.actors.size).toBe(0)
  })
  it("refuses records being deleted", async () => {
    await provision()
    present(fake.template().metadata).deleteTime = { seconds: 123n, nanos: 0 }
    await expect(provision()).rejects.toThrow(/being deleted/)
  })
})

describe("provisioning Job entry point", () => {
  let directory: string
  let entry: string
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "telegram-pi-provision-cli-"))
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
        "-p",
        fileURLToPath(new URL("./provision/tsconfig.cli.json", import.meta.url)),
        "--outDir",
        directory,
      ],
      { timeout: 30_000 },
    )
    symlinkSync(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(directory, "node_modules"),
    )
    writeFileSync(join(directory, "package.json"), '{"type":"module"}')
    entry = join(directory, "substrate/provision.js")
  })
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  it("has no automatic provisioning when imported", () => {
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(entry)}); console.log('import-only')`,
      ],
      { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH } },
    )
    expect(result.trim()).toBe("import-only")
  })
  it("exits nonzero for incomplete Job configuration", () => {
    const result = spawnSync(process.execPath, [entry], {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("DEVELOPMENT_HOSTS is required")
  })
  it("exits nonzero when golden readiness fails, with mTLS only and no Router", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", fileURLToPath(new URL("./provision/cli-failure.mjs", import.meta.url)), entry],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          SUBSTRATE_ATESPACE: templateConfig.atespace,
          ACTOR_TEMPLATE: templateConfig.name,
          ACTOR_IMAGE: templateConfig.image,
          OPENAI_BASE_URL: templateConfig.openAIBaseUrl,
          OPENAI_MODEL: templateConfig.openAIModel,
          OPENAI_MODEL_METADATA: templateConfig.openAIModelMetadata,
          LLM_CREDENTIAL_URI: egressConfig.llmCredentialUri,
          DEVELOPMENT_HOSTS: egressConfig.developmentHosts.join(","),
        },
      },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      "Golden snapshot build failed: FixtureFailed: readiness rejected",
    )
    expect(result.stdout).toBe("")
  })
})
