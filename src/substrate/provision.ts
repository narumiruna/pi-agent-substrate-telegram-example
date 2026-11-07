import { resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { status } from "@grpc/grpc-js"
import { openAIModels, PLACEHOLDER_KEY } from "../actor/config.js"
import { SubstrateClient, type WaitOptions } from "./client.js"
import {
  Actor,
  ActorMetadataField,
  ActorTemplate,
  type ControlService,
  EgressPolicy,
  GoldenSnapshotMode,
  type ObjectRef,
  type ResourceMetadata,
  type Snapshot,
  SnapshotFidelity,
  SnapshotOwner,
  SnapshotStorageState,
  type Tag,
} from "./generated/ateapi/v1/ateapi.js"

/** A permanent specification or identity rejection, not an unknown RPC outcome. */
export class ProvisionConflict extends Error {}

type ProvisionMethod =
  | "createActorTemplate"
  | "getActorTemplate"
  | "getTag"
  | "createActor"
  | "getActor"
  | "createActorEgressPolicy"
  | "getActorEgressPolicy"
type Input<M extends ProvisionMethod> = Parameters<
  (typeof ControlService)[M]["requestSerialize"]
>[0]
type Output<M extends ProvisionMethod> = ReturnType<
  (typeof ControlService)[M]["responseDeserialize"]
>

/** No Router, resume, update, or delete capability is needed by these helpers. */
export interface ProvisionClient {
  rpc<M extends ProvisionMethod>(
    method: M,
    input: Input<M>,
    options?: WaitOptions,
  ): Promise<Output<M>>
}
export interface ProvisionWaitOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}
export interface TemplateConfig {
  atespace: string
  name: string
  image: string
  openAIBaseUrl: string
  openAIModel: string
  openAIModelMetadata: string
  workerPoolLabel?: string
}
export interface EgressConfig {
  openAIBaseUrl: string
  llmCredentialUri: string
  developmentHosts: readonly string[]
}
export interface ConversationActorConfig {
  atespace: string
  // Use the name in the unique Gateway conversation mapping. Do not generate a new name on retry.
  name: string
  template: ObjectRef
  egress: EgressConfig
  // Once the mapping has a UID, refuse a missing or replaced Actor.
  expectedUid?: string
}
export interface ReadyTemplate {
  template: ActorTemplate
  goldenTag: ObjectRef
  snapshot: Snapshot
  // The API has no separate resolved-image status: image references must already contain digests.
  resolvedImages: string[]
}

function dnsLabel(value: string, field: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(`${field} must be a DNS label of at most 63 characters`)
  }
  return value
}
function hostname(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !value.includes(".") ||
    !value.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
    /^[0-9.]+$/.test(value)
  ) {
    throw new Error(
      "Destination must be an exact lowercase DNS hostname, not an IP, URL, or wildcard",
    )
  }
  return value
}
function llmEndpoint(value: string): { host: string; port: number } {
  // Validate before URL parsing, which would otherwise repair whitespace, case, and backslashes.
  if (typeof value !== "string" || !/^[!-~]+$/.test(value) || /[\\%]/.test(value))
    throw new Error("Invalid OPENAI_BASE_URL")
  const match = /^https:\/\/([^/:?#]+)(?::([1-9][0-9]{0,4}))?(\/[^?#]*)?$/.exec(value)
  if (!match) throw new Error("OPENAI_BASE_URL must be an explicit HTTPS base URL")
  const host = hostname(match[1])
  const port = match[2] ? Number(match[2]) : 443
  if (port > 65535) throw new Error("OPENAI_BASE_URL port is invalid")
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Invalid OPENAI_BASE_URL")
  return { host, port }
}
function pinnedImage(value: string): string {
  // OCI distribution name components, optional registry/port and tag, and exact sha256 digest.
  const match = /^([^@]+)@sha256:([a-f0-9]{64})$/.exec(value)
  if (!match || value.length > 512) throw new Error("Actor image must have an exact sha256 digest")
  let name = match[1]
  const tag = /:([\w][\w.-]{0,127})$/.exec(name)
  if (tag && name.lastIndexOf(":") > name.lastIndexOf("/")) name = name.slice(0, -tag[0].length)
  const parts = name.split("/")
  if (parts.length > 1 && /[.:]/.test(parts[0])) {
    const registry = parts.shift() as string
    const registryMatch = /^([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(registry)
    if (!registryMatch) throw new Error("Actor image registry is invalid")
    const [, host, port] = registryMatch
    if (host.length > 253) throw new Error("Actor image registry is invalid")
    for (const label of host.split(".")) dnsLabel(label, "Actor image registry")
    if (port !== undefined && Number(port) > 65535) {
      throw new Error("Actor image registry port is invalid")
    }
  }
  if (!parts.every((part) => /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(part))) {
    throw new Error("Actor image repository is invalid")
  }
  return value
}
function credentialUri(value: string): string {
  // This application uses the Kubernetes credential provider, never an inline key.
  const match =
    /^ate-secret:\/\/k8s\.io\/([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9.-]+)\/([A-Za-z0-9._-]+)$/.exec(
      value,
    )
  if (!match || value.length > 2048) throw new Error("Invalid Kubernetes LLM credential URI")
  dnsLabel(match[1], "credential provider")
  dnsLabel(match[2], "credential namespace")
  if (
    match[3].length > 253 ||
    !match[3].split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  ) {
    throw new Error("Invalid credential Secret name")
  }
  if (match[4].length > 253 || [".", ".."].includes(match[4]))
    throw new Error("Invalid credential key")
  return value
}
function ref(value: ObjectRef, field: string): ObjectRef {
  return {
    atespace: dnsLabel(value.atespace, `${field}.atespace`),
    name: dnsLabel(value.name, `${field}.name`),
  }
}
function uid(value: string | undefined, field: string): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`${field} has no valid UID`)
  }
  return value
}

/** A version name is immutable: use a new name whenever any caller-owned field changes. */
export function buildActorTemplate(config: TemplateConfig): ActorTemplate {
  const atespace = dnsLabel(config.atespace, "atespace")
  const name = dnsLabel(config.name, "template name")
  const image = pinnedImage(config.image)
  const pool = dnsLabel(config.workerPoolLabel ?? "telegram-pi", "worker pool label")
  llmEndpoint(config.openAIBaseUrl)
  for (const value of [config.openAIModel, config.openAIModelMetadata]) {
    if (!value || value.length > 256 || !/^[!-~]+$/.test(value))
      throw new Error("Invalid OpenAI model name")
  }
  // Use the Actor's own metadata lookup. Provisioning cannot accept a model the Actor will reject.
  openAIModels({
    OPENAI_BASE_URL: config.openAIBaseUrl,
    OPENAI_MODEL: config.openAIModel,
    OPENAI_MODEL_METADATA: config.openAIModelMetadata,
    OPENAI_API_KEY: PLACEHOLDER_KEY,
  })
  const trustPath = "/run/ate/egress-trust-bundle/trust-bundle.pem"
  return ActorTemplate.create({
    metadata: { atespace, name },
    workerSelector: { matchLabels: { workload: pool } },
    resources: { limits: { cpuMillicores: 1000n, memoryBytes: 536870912n } },
    snapshotConfig: {
      preferredFidelity: SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY,
      goldenSnapshotConfig: { mode: GoldenSnapshotMode.GOLDEN_SNAPSHOT_MODE_ENABLED },
    },
    containers: [
      {
        name: "pi",
        image,
        command: ["node", "/app/dist/actor/index.js"],
        env: [
          { name: "OPENAI_BASE_URL", value: config.openAIBaseUrl },
          { name: "OPENAI_MODEL", value: config.openAIModel },
          { name: "OPENAI_MODEL_METADATA", value: config.openAIModelMetadata },
          { name: "OPENAI_API_KEY", value: PLACEHOLDER_KEY },
          { name: "NODE_EXTRA_CA_CERTS", value: trustPath },
          { name: "SSL_CERT_FILE", value: trustPath },
          { name: "GIT_SSL_CAINFO", value: trustPath },
        ],
        wakeupProbe: { httpGet: { path: "/healthz", port: 80 }, timeoutSeconds: 30 },
        volumeMounts: [
          { name: "data", mountPath: "/data" },
          { name: "identity", mountPath: "/run/ate/identity" },
          { name: "egress-trust", mountPath: "/run/ate/egress-trust-bundle" },
        ],
      },
    ],
    volumes: [
      { name: "data", durableDir: {} },
      {
        name: "identity",
        systemInfo: {
          dataSources: [
            {
              actorMetadata: {
                items: [
                  { field: ActorMetadataField.ACTOR_METADATA_FIELD_NAME, path: "actor-name" },
                  { field: ActorMetadataField.ACTOR_METADATA_FIELD_ATESPACE, path: "atespace" },
                  { field: ActorMetadataField.ACTOR_METADATA_FIELD_UID, path: "actor-uid" },
                ],
              },
            },
          ],
        },
      },
      {
        name: "egress-trust",
        systemInfo: {
          dataSources: [
            {
              trustBundle: {
                names: ["egress-mitm.ate.dev", "system-roots.ate.dev"],
                path: "trust-bundle.pem",
              },
            },
          ],
        },
      },
    ],
    // Golden startup only serves /healthz. Pi state and network access are not initialized.
    // GoldenEgressPolicy is preview-only and is NOT inherited by conversation Actors.
  })
}

function dnsAliases(host: string): string[] {
  // runsc libc expands Kubernetes service lookups. Keep URL/SNI and certificate checks unchanged.
  return host.endsWith(".svc") ? [host, `${host}.cluster.local`] : [host]
}

export function buildActorEgressPolicy(atespace: string, config: EgressConfig): EgressPolicy {
  dnsLabel(atespace, "atespace")
  const llm = llmEndpoint(config.openAIBaseUrl)
  const credential = credentialUri(config.llmCredentialUri)
  if (!Array.isArray(config.developmentHosts) || config.developmentHosts.length > 255) {
    throw new Error("developmentHosts must be an explicit list with at most 255 hosts")
  }
  const llmHosts = dnsAliases(llm.host)
  const hosts = config.developmentHosts.map(hostname)
  const expanded = hosts.flatMap(dnsAliases)
  if (
    new Set(expanded).size !== expanded.length ||
    expanded.some((host) => llmHosts.includes(host))
  ) {
    throw new Error("Development hosts must be unique and must not collide with the LLM host")
  }
  return EgressPolicy.create({
    metadata: { atespace, name: "default" },
    rules: [
      {
        https: {
          hostnames: llmHosts,
          ports: { numbers: [llm.port] },
          effects: {
            replaceHeaders: [
              { header: "Authorization", prefix: "Bearer ", credentialUri: credential },
            ],
          },
        },
      },
      ...hosts
        .sort()
        .map((host) => ({ https: { hostnames: dnsAliases(host), ports: { numbers: [443] } } })),
    ],
  })
}

class Deadline {
  private readonly end: number
  private readonly poll: number
  private readonly options: ProvisionWaitOptions
  private readonly label: string
  constructor(options: ProvisionWaitOptions, label: string) {
    this.options = options
    this.label = label
    const timeout = options.timeoutMs ?? 600_000
    this.poll = options.pollIntervalMs ?? 1000
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3_600_000)
      throw new Error("Invalid provisioning timeoutMs")
    if (!Number.isInteger(this.poll) || this.poll < 1 || this.poll > 30_000)
      throw new Error("Invalid provisioning pollIntervalMs")
    this.end = performance.now() + timeout
  }
  remaining(): number {
    this.options.signal?.throwIfAborted()
    const remaining = Math.ceil(this.end - performance.now())
    if (remaining <= 0) throw new Error(`Provisioning deadline exceeded: ${this.label}`)
    return remaining
  }
  async rpc<M extends ProvisionMethod>(
    client: ProvisionClient,
    method: M,
    input: Input<M>,
  ): Promise<Output<M>> {
    try {
      const result = await client.rpc(method, input, {
        timeoutMs: Math.min(30_000, this.remaining()),
        signal: this.options.signal,
      })
      this.remaining()
      return result
    } catch (error) {
      this.remaining()
      throw error
    }
  }
  async pause() {
    try {
      await sleep(Math.min(this.poll, this.remaining()), undefined, { signal: this.options.signal })
    } catch (error) {
      this.options.signal?.throwIfAborted()
      throw error
    }
    this.remaining()
  }
}
function code(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : undefined
}
function transient(error: unknown): boolean {
  return [
    status.CANCELLED,
    status.UNKNOWN,
    status.DEADLINE_EXCEEDED,
    status.INTERNAL,
    status.UNAVAILABLE,
  ].includes(code(error) as number)
}
async function readRetry<T>(get: () => Promise<T>, deadline: Deadline): Promise<T> {
  for (;;) {
    try {
      return await get()
    } catch (error) {
      if (!transient(error)) throw error
      await deadline.pause()
    }
  }
}
async function createOrCompare<T>(
  create: () => Promise<T>,
  get: () => Promise<T>,
  compare: (record: T) => void,
  deadline: Deadline,
): Promise<T> {
  for (;;) {
    let record: T
    try {
      record = await create()
    } catch (error) {
      if (code(error) !== status.ALREADY_EXISTS && !transient(error)) throw error
      // A lost response is not a failed transaction. Read before another named Create.
      try {
        record = await readRetry(get, deadline)
      } catch (readError) {
        if (code(readError) !== status.NOT_FOUND) throw readError
        await deadline.pause()
        continue
      }
    }
    compare(record)
    return record
  }
}
function identity(metadata: ResourceMetadata | undefined, expected: ObjectRef, kind: string) {
  if (metadata?.deleteTime) throw new ProvisionConflict(`${kind} is being deleted`)
  if (metadata?.atespace !== expected.atespace || metadata.name !== expected.name) {
    throw new ProvisionConflict(`${kind} identity conflicts with the requested record`)
  }
  uid(metadata.uid, kind)
}
function owned<T extends { metadata: ResourceMetadata | undefined; status?: unknown }>(value: T) {
  const copy = structuredClone(value)
  if (copy.metadata) {
    copy.metadata = {
      ...copy.metadata,
      uid: "",
      version: 0n,
      createTime: undefined,
      updateTime: undefined,
      deleteTime: undefined,
    }
  }
  if ("status" in copy) copy.status = undefined
  return copy
}
function normalizeTemplate(value: ActorTemplate): ActorTemplate {
  const copy = owned(value)
  copy.snapshotConfig ??= {
    storageLocation: "",
    preferredFidelity: SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY,
    goldenSnapshotConfig: undefined,
  }
  if (!copy.snapshotConfig.preferredFidelity)
    copy.snapshotConfig.preferredFidelity = SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY
  copy.snapshotConfig.goldenSnapshotConfig ??= {
    mode: GoldenSnapshotMode.GOLDEN_SNAPSHOT_MODE_ENABLED,
  }
  if (!copy.snapshotConfig.goldenSnapshotConfig.mode)
    copy.snapshotConfig.goldenSnapshotConfig.mode = GoldenSnapshotMode.GOLDEN_SNAPSHOT_MODE_ENABLED
  copy.containers.sort((a, b) => a.name.localeCompare(b.name))
  for (const container of copy.containers) {
    container.env.sort((a, b) => a.name.localeCompare(b.name))
    container.volumeMounts.sort((a, b) => a.mountPath.localeCompare(b.mountPath))
    container.securityContext?.capabilities?.add.sort()
    container.securityContext?.capabilities?.drop.sort()
    if (container.wakeupProbe) {
      container.wakeupProbe.timeoutSeconds ||= 30
      if (container.wakeupProbe.httpGet) container.wakeupProbe.httpGet.path ||= "/"
    }
  }
  copy.volumes.sort((a, b) => a.name.localeCompare(b.name))
  for (const volume of copy.volumes) {
    for (const source of volume.systemInfo?.dataSources ?? []) source.trustBundle?.names.sort()
  }
  return copy
}
function normalizePolicy(value: EgressPolicy): EgressPolicy {
  const copy = owned(value)
  for (const rule of copy.rules) {
    for (const protocol of [rule.http, rule.https, rule.tlsPassthrough]) {
      if (!protocol) continue
      protocol.hostnames.sort()
      if (!protocol.ports && protocol !== rule.tlsPassthrough) {
        protocol.ports = { all: undefined, numbers: [protocol === rule.http ? 80 : 443] }
      }
      protocol.ports?.numbers.sort((a, b) => a - b)
    }
    for (const protocol of [rule.http, rule.https]) {
      if (!protocol?.effects) continue
      for (const effect of protocol.effects.replaceHeaders)
        effect.header = effect.header.toLowerCase()
      protocol.effects.replaceHeaders.sort((a, b) => a.header.localeCompare(b.header))
    }
  }
  copy.rules.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return copy
}
function conflict(kind: string, actual: unknown, expected: unknown) {
  if (!isDeepStrictEqual(actual, expected))
    throw new ProvisionConflict(
      `${kind} specification conflict; use a new version or reconcile the stored mapping`,
    )
}

async function readyTemplate(
  client: ProvisionClient,
  target: ObjectRef,
  deadline: Deadline,
  expected?: ActorTemplate,
): Promise<ReadyTemplate> {
  for (;;) {
    const template = await readRetry(
      () => deadline.rpc(client, "getActorTemplate", { actorTemplate: target }),
      deadline,
    )
    identity(template.metadata, target, "ActorTemplate")
    if (expected)
      conflict("ActorTemplate", normalizeTemplate(template), normalizeTemplate(expected))
    if (!template.containers.length) throw new Error("ActorTemplate has no resolved image digests")
    const resolvedImages = template.containers.map((container) => pinnedImage(container.image))
    const golden = template.status?.goldenSnapshotStatus
    if (golden?.errorMessage)
      throw new ProvisionConflict(`Golden snapshot build failed: ${golden.errorMessage}`)
    if (golden?.goldenTag) {
      const goldenTag = ref(golden.goldenTag, "goldenTag")
      if (goldenTag.atespace !== target.atespace)
        throw new ProvisionConflict("Golden tag atespace conflicts with its template")
      let tag: Tag | undefined
      try {
        tag = await deadline.rpc(client, "getTag", { tag: goldenTag })
      } catch (error) {
        if (code(error) !== status.NOT_FOUND && !transient(error)) throw error
      }
      if (tag) {
        identity(tag.metadata, goldenTag, "Golden tag")
        if (tag.status?.actorTemplateUid && tag.status.actorTemplateUid !== template.metadata?.uid)
          throw new ProvisionConflict("Golden tag belongs to another ActorTemplate UID")
        const snapshot = tag.status?.snapshot
        if (
          snapshot?.durableSnapshot?.state === SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED
        ) {
          if (
            !snapshot.uuid ||
            snapshot.generation < 1 ||
            snapshot.owner !== SnapshotOwner.SNAPSHOT_OWNER_TAG ||
            ![1, 2, 3].includes(snapshot.fidelity) ||
            snapshot.actorTemplateUid !== template.metadata?.uid ||
            tag.status?.actorTemplateUid !== template.metadata?.uid
          )
            throw new ProvisionConflict(
              "Golden tag completed snapshot identity or fidelity is invalid",
            )
          const uri = snapshot.durableSnapshot.object?.snapshotUri
          if (!uri || !/^(gs|s3):\/\/[^/\s]+\/[^\s]+$/.test(uri))
            throw new ProvisionConflict("Golden tag completed snapshot has no valid remote URI")
          return { template, goldenTag, snapshot, resolvedImages }
        }
      }
    }
    await deadline.pause()
  }
}

/** Create is not readiness. Wait for the golden tag's own completed remote copy. */
export async function ensureTemplate(
  client: ProvisionClient,
  config: TemplateConfig,
  options: ProvisionWaitOptions = {},
): Promise<ReadyTemplate> {
  const expected = buildActorTemplate(config)
  const target = { atespace: config.atespace, name: config.name }
  const deadline = new Deadline(
    options,
    `ActorTemplate ${target.atespace}/${target.name} golden readiness`,
  )
  await createOrCompare(
    () => deadline.rpc(client, "createActorTemplate", { actorTemplate: expected }),
    () => deadline.rpc(client, "getActorTemplate", { actorTemplate: target }),
    (record) => {
      identity(record.metadata, target, "ActorTemplate")
      conflict("ActorTemplate", normalizeTemplate(record), normalizeTemplate(expected))
    },
    deadline,
  )
  return readyTemplate(client, target, deadline, expected)
}

/** Return only after the matching default policy exists. This never resumes the Actor. */
export async function ensureActor(
  client: ProvisionClient,
  config: ConversationActorConfig,
  options: ProvisionWaitOptions = {},
): Promise<Actor> {
  const target = ref(config, "Actor")
  const template = ref(config.template, "ActorTemplate")
  const policy = buildActorEgressPolicy(target.atespace, config.egress)
  if (config.expectedUid !== undefined) uid(config.expectedUid, "stored Actor mapping")
  const deadline = new Deadline(options, `Actor ${target.atespace}/${target.name}`)
  const ready = await readyTemplate(client, template, deadline)
  const actorBaseUrl = ready.template.containers
    .flatMap((container) => container.env)
    .filter((variable) => variable.name === "OPENAI_BASE_URL")
  if (actorBaseUrl.length !== 1 || actorBaseUrl[0].value !== config.egress.openAIBaseUrl) {
    throw new ProvisionConflict("Actor EgressPolicy Base URL conflicts with the ActorTemplate")
  }
  const expected = Actor.create({
    metadata: target,
    actorTemplate: template,
    sourceTag: ready.goldenTag,
  })
  const compare = (record: Actor) => {
    identity(record.metadata, target, "Actor")
    if (config.expectedUid && record.metadata?.uid !== config.expectedUid)
      throw new ProvisionConflict("Actor UID conflicts with the stored mapping")
    conflict("Actor", owned(record), owned(expected))
  }
  let actor: Actor
  if (config.expectedUid) {
    try {
      actor = await readRetry(() => deadline.rpc(client, "getActor", { actor: target }), deadline)
    } catch (error) {
      if (code(error) === status.NOT_FOUND)
        throw new ProvisionConflict(
          "Stored Actor mapping is missing; automatic replacement is forbidden",
        )
      throw error
    }
    compare(actor)
  } else {
    actor = await createOrCompare(
      () => deadline.rpc(client, "createActor", { actor: expected }),
      () => deadline.rpc(client, "getActor", { actor: target }),
      compare,
      deadline,
    )
  }
  await createOrCompare(
    () => deadline.rpc(client, "createActorEgressPolicy", { actor: target, egressPolicy: policy }),
    () => deadline.rpc(client, "getActorEgressPolicy", { actor: target, name: "default" }),
    (record) => {
      identity(
        record.metadata,
        { atespace: target.atespace, name: "default" },
        "Actor EgressPolicy",
      )
      conflict("Actor EgressPolicy", normalizePolicy(record), normalizePolicy(policy))
    },
    deadline,
  )
  return actor
}

/** Job entry point. Operator bootstrap creates the atespace and editor grant separately. */
export async function provisionFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadyTemplate> {
  function required(name: string): string {
    const value = env[name]
    if (!value) throw new Error(`${name} is required`)
    return value
  }
  if (env.DEVELOPMENT_HOSTS === undefined)
    throw new Error("DEVELOPMENT_HOSTS is required (empty permits no development hosts)")
  const config: TemplateConfig = {
    atespace: required("SUBSTRATE_ATESPACE"),
    name: required("ACTOR_TEMPLATE"),
    image: required("ACTOR_IMAGE"),
    openAIBaseUrl: required("OPENAI_BASE_URL"),
    openAIModel: required("OPENAI_MODEL"),
    openAIModelMetadata: required("OPENAI_MODEL_METADATA"),
    workerPoolLabel: env.WORKER_POOL_LABEL ?? "telegram-pi",
  }
  buildActorEgressPolicy(config.atespace, {
    openAIBaseUrl: config.openAIBaseUrl,
    llmCredentialUri: required("LLM_CREDENTIAL_URI"),
    developmentHosts:
      env.DEVELOPMENT_HOSTS === ""
        ? []
        : env.DEVELOPMENT_HOSTS.split(",").map((host) => host.trim()),
  })
  const client = new SubstrateClient({
    caFile: env.SUBSTRATE_CA_FILE ?? "/var/run/ate/ca.crt",
    api: {
      auth: {
        kind: "mtls",
        bundleFile: env.SUBSTRATE_CREDENTIAL_BUNDLE ?? "/var/run/ate/credential-bundle.pem",
      },
    },
  })
  try {
    return await ensureTemplate(client, config)
  } finally {
    await client.close()
  }
}

// Importing these helpers has no startup effects. Only the Job's direct entry runs provisioning.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  provisionFromEnvironment()
    .then((ready) => {
      console.info(
        JSON.stringify({
          template: ready.template.metadata?.name,
          uid: ready.template.metadata?.uid,
          goldenTag: ready.goldenTag,
          fidelity: ready.snapshot.fidelity,
          snapshotUri: ready.snapshot.durableSnapshot?.object?.snapshotUri,
          resolvedImages: ready.resolvedImages,
        }),
      )
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Provisioning failed")
      process.exitCode = 1
    })
}
