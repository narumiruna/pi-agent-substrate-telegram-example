// Explicit local Substrate suite. Never included in Vitest; no real model or Telegram calls.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { setTimeout } from "node:timers/promises"
import { status } from "@grpc/grpc-js"
import { SubstrateClient } from "../src/substrate/client.js"
import {
  Actor,
  ActorState,
  ActorTemplate,
  DurabilityMode,
  EgressPolicy,
  GoldenSnapshotMode,
  type Snapshot,
  SnapshotFidelity,
  SnapshotOwner,
  SnapshotStorageState,
} from "../src/substrate/generated/ateapi/v1/ateapi.js"

assert.equal(
  process.argv[2],
  "--identity-gate-ready",
  "Wait for main's task4 runtime identity gate",
)
const mode = process.argv[3]
assert(["prepare", "detach", "verify", "finish"].includes(mode))
const image = process.env.ACTOR_IMAGE ?? ""
assert.match(image, /^localhost:25071\/telegram-pi-actor-proof@sha256:[0-9a-f]{64}$/)
const credentialUri = process.env.ACTOR_CREDENTIAL_URI ?? ""
assert(credentialUri?.startsWith("ate-secret://"))
const atespace = "telegram-pi-actor-validation"
const base = "/tmp/actor-runtime"
mkdirSync(base, { recursive: true })
const client = new SubstrateClient({
  caFile: "/var/run/ate/ca.crt",
  api: { auth: { kind: "mtls", bundleFile: "/var/run/ate/credential-bundle.pem" } },
  router: {
    origin: "https://atenet-router.ate-system.svc",
    bundleFile: "/var/run/ate/credential-bundle.pem",
  },
})
interface Quiescence {
  initialized: boolean
  quiescent: boolean
  active: boolean
  actorUid: string
  instanceId: string
  conversationId: string
  providerSessionId: string
  recoveryRequired: boolean
}
interface Receipt {
  requestId: string
  submissionId: string
  conversationId: string
  piStatus: string
  status: string
  answer?: string
}
interface StorageProof {
  integrity: string
  walBytes: number
  workspace: string
  mainContainsSentinel: boolean
  walContainsSentinel: boolean
  conversationId: string
  providerSessionId: string
  userEntries: { id: number; content: string }[]
  rawEntryIds: number[]
}
interface Saved {
  name: string
  fidelity: SnapshotFidelity
  before: Quiescence
  receipt: Receipt
  snapshot: unknown
  proof?: StorageProof
}
let saved: Saved[] = []
function record(check: string, details?: unknown) {
  console.log(JSON.stringify({ check, result: "PASS", details }))
}
const ref = (name: string) => ({ atespace, name })
async function http<T>(
  name: string,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
  expected = 200,
): Promise<T> {
  const result = await client.actor(
    ref(name),
    { method, path, body: body === undefined ? undefined : JSON.stringify(body) },
    { timeoutMs: 120_000 },
  )
  assert.equal(result.statusCode, expected, result.body.toString())
  assert(result.body.length <= 131_072)
  return JSON.parse(result.body.toString())
}
async function eventually<T>(
  get: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await get()
    if (accept(value)) return value
    assert(Date.now() < deadline, "Runtime wait timed out")
    await setTimeout(250)
  }
}
async function create<T>(operation: () => Promise<T>) {
  try {
    await operation()
  } catch (error) {
    if ((error as { code?: number }).code !== status.ALREADY_EXISTS) throw error
  }
}
function latest(actor: Actor): Snapshot {
  const snapshot = actor.status?.snapshots.find(
    (item) => item.generation === actor.status?.lastAssignedGeneration,
  )
  assert.equal(actor.status?.state, ActorState.ACTOR_STATE_SUSPENDED)
  assert(snapshot?.uuid)
  assert.equal(
    snapshot.owner,
    SnapshotOwner.SNAPSHOT_OWNER_ACTOR,
    "remote restore must use a private Actor-owned snapshot",
  )
  assert.equal(
    snapshot.durableSnapshot?.state,
    SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
  )
  assert(snapshot.durableSnapshot.object?.snapshotUri)
  return snapshot
}
async function checkpoint(name: string) {
  const quiet = await http<Quiescence>(name, "/v1/quiescence")
  assert(quiet.quiescent && !quiet.recoveryRequired)
  await client.rpc(
    "suspendActor",
    { actor: ref(name), options: { mode: DurabilityMode.DURABILITY_MODE_SYNCHRONOUS } },
    { timeoutMs: 180_000 },
  )
  const actor = await eventually(
    () => client.rpc("getActor", { actor: ref(name) }),
    (actor) =>
      actor.status?.snapshots.some(
        (item) =>
          item.generation === actor.status?.lastAssignedGeneration &&
          item.durableSnapshot?.state === SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
      ) ?? false,
  )
  assert.equal(actor.metadata?.uid, quiet.actorUid)
  const snapshot = latest(actor)
  record("latest remote checkpoint completed", {
    actorUid: actor.metadata?.uid,
    snapshot: snapshot.uuid,
    generation: snapshot.generation,
    fidelity: SnapshotFidelity[snapshot.fidelity],
    uri: snapshot.durableSnapshot?.object?.snapshotUri,
  })
  return SnapshotJSON(snapshot)
}
function SnapshotJSON(snapshot: Snapshot) {
  // All snapshot fields are JSON-safe (unlike Actor metadata timestamps).
  return JSON.parse(JSON.stringify(snapshot))
}
async function storageProof(name: string, updateId: number) {
  const requestId = `telegram:900001:${updateId}`
  await http(
    name,
    "/v1/submissions",
    "POST",
    { requestId, text: `actor-storage-proof:${name}:${updateId}` },
    202,
  )
  const result = await eventually(
    () => http<Receipt>(name, `/v1/submissions?requestId=${encodeURIComponent(requestId)}`),
    (value) => value.status !== "pending",
  )
  assert.equal(result.status, "done", JSON.stringify(result))
  const proof = JSON.parse(result.answer ?? "") as StorageProof
  assert.equal(proof.integrity, "ok")
  assert.equal(proof.workspace, "fixture tool output\n")
  assert(proof.walBytes > 32)
  await eventually(
    () => http<Quiescence>(name, "/v1/quiescence"),
    (value) => value.quiescent,
  )
  record("live SQLite and workspace proof", { name, proof })
  return proof
}
async function prepare() {
  const runId = randomUUID().slice(0, 8)
  for (const [suffix, fidelity] of [
    ["memory", SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY],
    ["cold", SnapshotFidelity.SNAPSHOT_FIDELITY_VOLUMES],
  ] as const) {
    const templateName = `pi-${suffix}-${image.split(":").at(-1)?.slice(0, 12)}-wal`
    const name = `${templateName}-${runId}`
    const template = ActorTemplate.create({
      metadata: { atespace, name: templateName },
      workerSelector: { matchLabels: { workload: "telegram-pi-platform-smoke" } },
      containers: [
        {
          name: "actor",
          image,
          env: [
            {
              name: "OPENAI_BASE_URL",
              value: "https://synthetic-api.telegram-pi-fixtures.svc/openai/v1",
            },
            { name: "OPENAI_API_KEY", value: "substrate-egress-placeholder" },
            { name: "OPENAI_MODEL", value: "gpt-4o-mini" },
            { name: "OPENAI_MODEL_METADATA", value: "gpt-4o-mini" },
            { name: "NODE_EXTRA_CA_CERTS", value: "/run/ate/identity/ca.crt" },
          ],
          wakeupProbe: { httpGet: { path: "/wakeup", port: 80 }, timeoutSeconds: 30 },
          volumeMounts: [
            { name: "data", mountPath: "/data" },
            { name: "identity", mountPath: "/run/ate/identity" },
          ],
        },
      ],
      resources: { limits: { cpuMillicores: 1000n, memoryBytes: 536870912n } },
      snapshotConfig: {
        preferredFidelity: fidelity,
        goldenSnapshotConfig: { mode: GoldenSnapshotMode.GOLDEN_SNAPSHOT_MODE_ENABLED },
      },
      volumes: [
        { name: "data", durableDir: {} },
        {
          name: "identity",
          systemInfo: {
            dataSources: [
              {
                actorMetadata: {
                  items: [
                    { field: 1, path: "actor-name" },
                    { field: 2, path: "atespace" },
                    { field: 3, path: "actor-uid" },
                  ],
                },
              },
              {
                trustBundle: {
                  names: ["egress-mitm.ate.dev", "system-roots.ate.dev"],
                  path: "ca.crt",
                },
              },
            ],
          },
        },
      ],
    })
    await create(() => client.rpc("createActorTemplate", { actorTemplate: template }))
    const actual = await eventually(
      () => client.rpc("getActorTemplate", { actorTemplate: ref(templateName) }),
      (value) => {
        assert(
          !value.status?.goldenSnapshotStatus?.errorMessage,
          value.status?.goldenSnapshotStatus?.errorMessage ?? "golden build failure",
        )
        return Boolean(value.status?.goldenSnapshotStatus?.goldenTag)
      },
    )
    const normalized = ActorTemplate.create({
      ...actual,
      metadata: { name: templateName, atespace },
      status: undefined,
    })
    assert.deepEqual(normalized, template, "immutable template conflict")
    const goldenRef = actual.status?.goldenSnapshotStatus?.goldenTag
    assert(goldenRef)
    const golden = await client.rpc("getTag", { tag: goldenRef })
    assert.equal(
      golden.status?.snapshot?.durableSnapshot?.state,
      SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
    )
    assert(golden.status?.snapshot?.durableSnapshot?.object?.snapshotUri)
    record("golden snapshot ready", {
      name,
      fidelity: SnapshotFidelity[golden.status?.snapshot?.fidelity ?? 0],
    })
    await create(() =>
      client.rpc("createActor", {
        actor: Actor.create({ metadata: ref(name), actorTemplate: ref(templateName) }),
      }),
    )
    const actor = await client.rpc("getActor", { actor: ref(name) })
    assert.deepEqual(actor.actorTemplate, ref(templateName))
    const policy = EgressPolicy.create({
      metadata: { atespace, name: "default" },
      rules: [
        {
          https: {
            hostnames: [
              "synthetic-api.telegram-pi-fixtures.svc",
              "synthetic-api.telegram-pi-fixtures.svc.cluster.local",
            ],
            ports: { numbers: [443] },
            effects: {
              replaceHeaders: [{ header: "Authorization", prefix: "Bearer ", credentialUri }],
            },
          },
        },
      ],
    })
    await create(() =>
      client.rpc("createActorEgressPolicy", { actor: ref(name), egressPolicy: policy }),
    )
    const actualPolicy = await client.rpc("getActorEgressPolicy", {
      actor: ref(name),
      name: "default",
    })
    assert.deepEqual(actualPolicy.rules, policy.rules)
    const before = await http<Quiescence>(name, "/v1/quiescence")
    assert.equal(before.initialized, false, "golden cloned writable Pi state")
    await http(name, "/v1/submissions?requestId=telegram%3A900001%3A777", "GET", undefined, 404)
    const requestId = "telegram:900001:777"
    const text = `WAL and workspace sentinel ${name}`
    const receipt = await http<Receipt>(name, "/v1/submissions", "POST", { requestId, text }, 202)
    const result = await eventually(
      () => http<Receipt>(name, `/v1/submissions?requestId=${encodeURIComponent(requestId)}`),
      (value) => value.status !== "pending",
    )
    assert.equal(result.status, "done", JSON.stringify(result))
    assert.equal(result.answer, "Fixture tool turn complete.")
    assert.equal(result.submissionId, receipt.submissionId)
    const duplicate = await http<Receipt>(name, "/v1/submissions", "POST", { requestId, text }, 202)
    assert.deepEqual(duplicate, result)
    await http(name, "/v1/submissions", "POST", { requestId, text: "changed" }, 409)
    const quiet = await eventually(
      () => http<Quiescence>(name, "/v1/quiescence"),
      (value) => value.quiescent,
    )
    assert.equal(quiet.actorUid, actor.metadata?.uid)
    assert(quiet.providerSessionId && quiet.instanceId)
    record("Pi adapter tool turn, deduplication, and fresh identity", {
      name,
      quiet,
      receipt: result,
    })
    const proof = await storageProof(name, 778)
    assert.equal(
      proof.mainContainsSentinel,
      false,
      "sentinel already checkpointed into main SQLite file",
    )
    assert.equal(proof.walContainsSentinel, true, "sentinel absent from live WAL")
    const snapshot = await checkpoint(name)
    assert.equal(snapshot.fidelity, fidelity, "requested fidelity was not captured")
    saved.push({ name, fidelity, before: quiet, receipt: result, snapshot, proof })
    writeFileSync(`${base}/state.json`, JSON.stringify(saved, null, 2))
  }
  assert.notEqual(saved[0].before.actorUid, saved[1].before.actorUid)
  assert.notEqual(saved[0].before.providerSessionId, saved[1].before.providerSessionId)
  record("two Actors have separate provider identities")
}
async function detach() {
  for (const item of saved) {
    const actor = await client.rpc("getActor", { actor: ref(item.name) })
    assert.deepEqual(SnapshotJSON(latest(actor)), item.snapshot, "checkpoint changed before detach")
    const reverted = await client.rpc(
      "revertActor",
      { actor: ref(item.name) },
      { timeoutMs: 180_000 },
    )
    assert(reverted.actor)
    const snapshot = latest(reverted.actor)
    assert.equal(
      snapshot.uuid,
      (item.snapshot as Snapshot).uuid,
      "Revert discarded the intended snapshot",
    )
    assert.equal(snapshot.locality, "")
    record("completed test snapshot detached without rollback", {
      name: item.name,
      snapshot: snapshot.uuid,
    })
  }
}
async function verify() {
  for (const item of saved) {
    const receipt = await http<Receipt>(
      item.name,
      `/v1/submissions?requestId=${encodeURIComponent(item.receipt.requestId)}`,
    )
    assert.deepEqual(receipt, item.receipt)
    const quiet = await eventually(
      () => http<Quiescence>(item.name, "/v1/quiescence"),
      (value) => value.quiescent,
    )
    assert.equal(quiet.actorUid, item.before.actorUid)
    assert.equal(quiet.providerSessionId, item.before.providerSessionId)
    assert.equal(quiet.conversationId, item.before.conversationId)
    if (item.fidelity === SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY)
      assert.equal(quiet.instanceId, item.before.instanceId, "memory restore cold-booted")
    else
      assert.notEqual(
        quiet.instanceId,
        item.before.instanceId,
        "disk restore reused the old process",
      )
    const proof = await storageProof(item.name, 779)
    assert.equal(proof.conversationId, item.before.conversationId)
    assert.equal(proof.providerSessionId, item.before.providerSessionId)
    assert(item.proof)
    for (const user of item.proof.userEntries)
      assert(
        proof.userEntries.some((entry) => entry.id === user.id && entry.content === user.content),
        "raw user history lost on restore",
      )
    for (const id of item.proof.rawEntryIds)
      assert(proof.rawEntryIds.includes(id), "raw transcript entry lost on restore")
    record("restored same Pi submission and provider identity", {
      name: item.name,
      quiet,
      fidelity: SnapshotFidelity[item.fidelity],
    })
  }
}
try {
  if (mode === "prepare") await prepare()
  else {
    saved = JSON.parse(readFileSync(`${base}/state.json`, "utf8"))
    assert.equal(saved.length, 2)
    if (mode === "detach") await detach()
    if (mode === "verify") await verify()
    if (mode === "finish") for (const item of saved) await checkpoint(item.name)
  }
} finally {
  await client.close()
}
