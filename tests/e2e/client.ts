// Explicit kind runtime client. No credentials or database URLs are written to evidence.
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { Pool } from "pg"
import { GatewayStore } from "../../src/gateway/store.js"
import { SubstrateClient } from "../../src/substrate/client.js"
import {
  type Actor,
  ActorState,
  ActorTemplate,
  DurabilityMode,
  type Snapshot,
  SnapshotFidelity,
  SnapshotOwner,
  SnapshotStorageState,
} from "../../src/substrate/generated/ateapi/v1/ateapi.js"
import { ensureActor } from "../../src/substrate/provision.js"

const phase = process.argv[2]
const run = process.argv[3] ?? ""
assert.match(run, /^[a-f0-9]{16}$/)
const base = `/tmp/e2e-${run}`
mkdirSync(base, { recursive: true, mode: 0o700 })
const file = `${base}/state.json`
const atespace = process.env.SUBSTRATE_ATESPACE ?? ""
const templateName = process.env.ACTOR_TEMPLATE ?? ""
const image = process.env.ACTOR_IMAGE ?? ""
assert.equal(atespace, "telegram-pi")
assert.match(image, /^localhost:25071\/telegram-pi-actor@sha256:[a-f0-9]{64}$/)
const client = new SubstrateClient({
  caFile: "/var/run/ate/ca.crt",
  api: { auth: { kind: "mtls", bundleFile: "/var/run/ate/credential-bundle.pem" } },
  router: {
    origin: "https://atenet-router.ate-system.svc",
    bundleFile: "/var/run/ate/credential-bundle.pem",
  },
})
const pool = new Pool({
  connectionString: readFileSync("/var/run/database/url", "utf8").trim(),
  max: 2,
  query_timeout: 10_000,
  connectionTimeoutMillis: 10_000,
})
const store = new GatewayStore(pool)
const ref = (name: string) => ({ atespace, name })
const fixtureOrigin = "https://synthetic-api.telegram-pi-fixtures.svc"
// biome-ignore lint/suspicious/noExplicitAny: bounded external JSON evidence is validated at each assertion.
type Json = Record<string, any>
let state: Json = phase === "baseline" ? {} : JSON.parse(readFileSync(file, "utf8"))
function save() {
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 })
}
function event(check: string, details: unknown = {}) {
  console.log(JSON.stringify({ check, result: "PASS", details }))
}
async function fixture(path = "/__fixture/state", body?: unknown): Promise<Json> {
  const response = await fetch(`${fixtureOrigin}${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, 200, `Fixture ${path} failed`)
  return response.json() as Promise<Json>
}
async function eventually<T>(
  get: () => Promise<T>,
  accept: (v: T) => boolean,
  ms = 240_000,
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await get()
    if (accept(v)) return v
    assert(Date.now() < end, "E2E bounded wait expired")
    await sleep(200)
  }
}
async function http(name: string, path: string, body?: unknown): Promise<Json> {
  const response = await client.actor(
    ref(name),
    {
      method: body === undefined ? "GET" : "POST",
      path,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { timeoutMs: 120_000 },
  )
  assert.equal(
    response.statusCode,
    body === undefined ? 200 : 202,
    `Actor HTTP status ${response.statusCode}`,
  )
  return JSON.parse(response.body.toString())
}
function plain(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)))
}
async function actors() {
  const result = await client.rpc("listActors", {
    atespace,
    options: { pageSize: 1000, pageToken: "" },
  })
  assert.equal(result.nextPageToken, "", "Actor pagination exceeds test bound")
  return result.actors
}
async function database(): Promise<Json> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ")
    const conversations = (
      await db.query(
        "SELECT key, bot_id::text, chat_id::text, thread_id::text, actor_name, actor_uid::text FROM gateway.conversations WHERE bot_id=900001 ORDER BY key",
      )
    ).rows
    const jobs = (
      await db.query(
        "SELECT j.*, i.update_id::text, i.input_text FROM gateway.jobs j JOIN gateway.inbox i USING(request_id) WHERE i.bot_id=900001 ORDER BY j.sequence",
      )
    ).rows
    const outbox = (
      await db.query(
        "SELECT o.* FROM gateway.outbox o JOIN gateway.inbox i USING(request_id) WHERE i.bot_id=900001 ORDER BY o.sequence,o.chunk_index",
      )
    ).rows
    const cursor =
      (await db.query("SELECT next_offset::text FROM gateway.polling_cursors WHERE bot_id=900001"))
        .rows[0]?.next_offset ?? "0"
    await db.query("COMMIT")
    return plain({ conversations, jobs, outbox, cursor })
  } finally {
    await db.query("ROLLBACK")
    db.release()
  }
}
function update(
  id: number,
  chat: number,
  thread: number | undefined,
  text: string,
  sender = 102825484,
  trigger = true,
) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1,
      from: { id: sender, is_bot: false, first_name: "Synthetic" },
      chat: { id: chat, type: chat > 0 ? "private" : "supergroup" },
      ...(thread === undefined ? {} : { message_thread_id: thread }),
      text,
      ...(chat < 0 && trigger
        ? { reply_to_message: { message_id: 1, from: { id: 900001, is_bot: true } } }
        : {}),
    },
  }
}
function latest(actor: Actor): Snapshot {
  assert.equal(actor.status?.state, ActorState.ACTOR_STATE_SUSPENDED)
  const candidates = actor.status.snapshots.filter(
    (s) => s.generation === actor.status?.lastAssignedGeneration,
  )
  assert.equal(candidates.length, 1)
  const snapshot = candidates[0]
  assert(snapshot?.uuid)
  assert.equal(snapshot.owner, SnapshotOwner.SNAPSHOT_OWNER_ACTOR)
  assert.equal(
    snapshot.durableSnapshot?.state,
    SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
  )
  assert(snapshot.durableSnapshot.object?.snapshotUri)
  return snapshot
}
async function checkpoint(name: string) {
  const quiet = await eventually(
    () => http(name, "/v1/quiescence"),
    (q) => q.quiescent && !q.active && !q.recoveryRequired,
  )
  await client.rpc(
    "suspendActor",
    { actor: ref(name), options: { mode: DurabilityMode.DURABILITY_MODE_SYNCHRONOUS } },
    { timeoutMs: 180_000 },
  )
  const actor = await eventually(
    () => client.rpc("getActor", { actor: ref(name) }),
    (a) =>
      a.status?.state === ActorState.ACTOR_STATE_SUSPENDED &&
      a.status.snapshots.some(
        (s) =>
          s.generation === a.status?.lastAssignedGeneration &&
          s.durableSnapshot?.state === SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
      ),
  )
  assert.equal(actor.metadata?.uid, quiet.actorUid)
  return { quiet, snapshot: latest(actor) }
}
async function submit(name: string, requestId: string, text: string) {
  const initial = await http(name, "/v1/submissions", { requestId, text })
  const result = await eventually(
    () => http(name, `/v1/submissions?requestId=${encodeURIComponent(requestId)}`),
    (r) => r.status !== "pending",
  )
  assert.equal(result.status, "done")
  assert.equal(result.recoveryRequired, false)
  assert.equal(result.submissionId, initial.submissionId)
  return result
}
function proof(receipt: Json, marker: string) {
  const p = JSON.parse(receipt.answer)
  assert.equal(p.marker, marker)
  assert.equal(p.integrity, "ok")
  assert(p.walBytes > 32)
  assert.equal(p.workspace, `${marker}\n`)
  assert.deepEqual(p.network, {
    allowed: 200,
    authorization: null,
    denied: 403,
    deniedBody: "egress denied",
    after: 200,
  })
  assert.equal(p.absent.length, 3)
  return p
}
async function observe() {
  const db = await database()
  const actual = await actors()
  const own = actual.filter((a) =>
    db.conversations.some(
      (c: Json) => c.actor_name === a.metadata?.name && c.actor_uid === a.metadata?.uid,
    ),
  )
  const occupied = own.filter(
    (a) =>
      ![ActorState.ACTOR_STATE_SUSPENDED, ActorState.ACTOR_STATE_CRASHED].includes(
        a.status?.state ?? 0,
      ),
  ).length
  assert(occupied <= 2, "More than two mapped Actors occupy capacity")
  const assignments = own.flatMap((a) =>
    a.status?.workerAssignment ? [a.status.workerAssignment] : [],
  )
  for (const assignment of assignments) {
    assert.equal(assignment.workerNamespace, "telegram-pi")
    assert.equal(assignment.workerPool, "telegram-pi")
  }
  assert.equal(
    new Set(assignments.map((a) => a.worker?.name)).size,
    assignments.length,
    "Two mapped Actors share one occupied worker",
  )
  const f = await fixture()
  for (const reply of db.outbox) {
    const job = db.jobs.find((j: Json) => j.request_id === reply.request_id)
    if (reply.state !== "blocked") {
      assert.equal(job.state, "completed")
      assert.equal(
        job.checkpoint.actorUid,
        db.conversations.find((c: Json) => c.key === job.conversation_key).actor_uid,
      )
      assert.equal(job.checkpoint.snapshotId, job.suspend_snapshot_id)
      assert.equal(job.checkpoint.generation, String(job.suspend_generation))
      // Reuse can advance an Actor; the captured receipt remains its prior checkpoint.
      const actor = own.find((a) => a.metadata?.uid === job.checkpoint.actorUid)
      assert(actor)
      const snapshot = actor.status?.snapshots.find((s) => s.uuid === job.checkpoint.snapshotId)
      if (snapshot) {
        assert.equal(String(snapshot.generation), job.checkpoint.generation)
        assert.equal(
          snapshot.durableSnapshot?.state,
          SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
        )
        assert.equal(snapshot.durableSnapshot.object?.snapshotUri, job.checkpoint.remoteUri)
      } else assert((actor.status?.lastAssignedGeneration ?? 0) > Number(job.checkpoint.generation))
    }
  }
  const sample = {
    at: new Date().toISOString(),
    occupied,
    db,
    actors: own.map((a) => plain(a)),
    sent: f.sent.filter((s: Json) => state.chats?.includes(s.chat.id)),
  }
  appendFileSync(`${base}/observations.jsonl`, `${JSON.stringify(sample)}\n`)
  state.maxOccupancy = Math.max(state.maxOccupancy ?? 0, occupied)
  return { db, f, actual }
}
async function waitDone(ids: number[]) {
  await eventually(async () => {
    const sample = await observe()
    const jobs = sample.db.jobs.filter((j: Json) => ids.includes(Number(j.update_id)))
    const replies = sample.db.outbox.filter((o: Json) =>
      jobs.some((j: Json) => j.request_id === o.request_id),
    )
    assert(
      !jobs.some((j: Json) => ["failed", "recovery_needed"].includes(j.state)),
      "Packaged dispatch entered failure/recovery",
    )
    assert(
      !replies.some((r: Json) => ["uncertain", "failed"].includes(r.state)),
      "Packaged reply requires reconciliation",
    )
    return (
      jobs.length === ids.length &&
      jobs.every((j: Json) => j.state === "completed") &&
      replies.length === ids.length &&
      replies.every((o: Json) => o.state === "sent")
    )
  }, Boolean)
}
async function baseline() {
  const f = await fixture()
  assert.equal(f.updates.length, 0, "Retain unrelated pending fixture updates; do not reset")
  assert(
    f.calls.length < 1200,
    "Insufficient retained fixture call capacity; do not reset live state",
  )
  const db = await database()
  assert(
    db.jobs.every((j: Json) => ["completed", "failed"].includes(j.state)),
    "Existing work is not drained",
  )
  assert(
    db.outbox.every((r: Json) => r.state === "sent"),
    "Existing outbox is not drained",
  )
  const template = await client.rpc("getActorTemplate", { actorTemplate: ref(templateName) })
  assert.equal(template.containers.length, 1)
  assert.equal(template.containers[0]?.image, image)
  assert.equal(template.workerSelector?.matchLabels.workload, "telegram-pi")
  assert.equal(
    template.snapshotConfig?.preferredFidelity,
    SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY,
  )
  state = {
    run,
    baseline: db,
    baselineActors: (await actors()).map((a) => plain(a)),
    fixtureBaseline: f,
    image,
    template: plain(template),
    offset: Math.max(Number(db.cursor), Number(f.acknowledgedOffset ?? 0), Date.now()) + 100,
    maxOccupancy: 0,
  }
  state.chats = [state.offset + 100, -(state.offset + 101)]
  state.routes = [
    { chat: state.chats[0] },
    { chat: state.chats[1], thread: 71 },
    { chat: state.chats[1], thread: 72 },
  ]
  save()
  event("production image, immutable template, drained private DB and retained fixtures", {
    image,
    run,
  })
}
async function reject() {
  const id = state.offset
  const rejected = [
    update(id, state.chats[0] + 20, undefined, `rejected:${run}:unauthorized`, 102),
    update(id + 1, state.chats[1] - 20, 1, `rejected:${run}:nontrigger`, 102825484, false),
    {
      ...update(id + 2, state.chats[0] + 21, undefined, `rejected:${run}:anonymous`),
      message: {
        ...update(id + 2, state.chats[0] + 21, undefined, `rejected:${run}:anonymous`).message,
        sender_chat: { id: -999 },
      },
    },
  ]
  state.rejected = rejected
  await fixture("/__fixture/append", { updates: rejected })
  await eventually(
    () => store.getCursor("900001"),
    (c) => Number(c) > id + 2,
  )
  const after = await database()
  assert.deepEqual(after.jobs, state.baseline.jobs)
  assert.deepEqual(after.conversations, state.baseline.conversations)
  assert.deepEqual(
    (await actors()).map((a) => a.metadata?.uid).sort(),
    state.baselineActors.map((a: Json) => a.metadata.uid).sort(),
  )
  assert.equal(
    (await fixture()).calls.filter((c: Json) => c.path === "/openai/v1/responses").length,
    state.fixtureBaseline.calls.filter((c: Json) => c.path === "/openai/v1/responses").length,
  )
  save()
  event("rejected and non-triggering updates advance cursor without work, Actors, or model history")
}
async function admit() {
  state.seeds = state.routes.map((route: Json, i: number) =>
    update(state.offset + 10 + i, route.chat, route.thread, `e2e-seed:${run}-${"abc"[i]}`),
  )
  await fixture("/__fixture/append", { updates: state.seeds })
  save()
  event("three authorized chat/topic inputs appended without resetting existing data")
}
async function restartBoundary() {
  await eventually(async () => {
    const { db } = await observe()
    const jobs = db.jobs.filter((j: Json) =>
      state.seeds.some((u: Json) => Number(j.update_id) === u.update_id),
    )
    if (jobs.length !== 3 || Number(db.cursor) <= state.offset + 12) return false
    assert(
      !jobs.some(
        (j: Json) =>
          ["failed", "recovery_needed"].includes(j.state) ||
          (j.final_outcome !== null && j.final_outcome !== "succeeded"),
      ),
      "Seed failed before the restart boundary; retain it without replay",
    )
    if (!jobs.some((j: Json) => j.state === "result_awaiting_checkpoint")) return false
    if (
      !db.outbox.some(
        (o: Json) => o.state === "blocked" && jobs.some((j: Json) => j.request_id === o.request_id),
      )
    )
      return false
    state.beforeRestart = db
    return true
  }, Boolean)
  save()
  event(
    "restart boundary captured: committed cursor, accepted work, blocked outbox and checkpoint in progress",
  )
}
async function verify() {
  await waitDone(state.seeds.map((u: Json) => u.update_id))
  const { db, f, actual } = await observe()
  const mapped = db.conversations.filter((c: Json) =>
    state.routes.some(
      (r: Json) =>
        String(r.chat) === c.chat_id &&
        (r.thread === undefined ? c.thread_id === null : String(r.thread) === c.thread_id),
    ),
  )
  assert.equal(mapped.length, 3)
  assert.equal(new Set(mapped.map((c: Json) => c.actor_uid)).size, 3)
  for (const old of state.beforeRestart.conversations) {
    const now = db.conversations.find((c: Json) => c.key === old.key)
    assert(now)
    assert.equal(now.actor_name, old.actor_name)
    if (old.actor_uid) assert.equal(now.actor_uid, old.actor_uid)
  }
  assert(Number(db.cursor) >= Number(state.beforeRestart.cursor))
  const providers = new Set()
  for (const [i, input] of state.seeds.entries()) {
    const job = db.jobs.find((j: Json) => Number(j.update_id) === input.update_id)
    const mapping = mapped.find((c: Json) => c.key === job.conversation_key)
    const actor = actual.find((a) => a.metadata?.uid === mapping.actor_uid)
    assert(actor)
    const snapshot = latest(actor)
    assert.equal(snapshot.uuid, job.checkpoint.snapshotId)
    assert.equal(String(snapshot.generation), job.checkpoint.generation)
    assert.equal(snapshot.durableSnapshot?.object?.snapshotUri, job.checkpoint.remoteUri)
    const reply = db.outbox.find((o: Json) => o.request_id === job.request_id)
    const sent = f.sent.find(
      (s: Json) => String(s.message_id) === String(reply.response_message_id),
    )
    assert(sent)
    assert.equal(String(sent.chat.id), mapping.chat_id)
    assert.equal(
      sent.message_thread_id === undefined ? null : String(sent.message_thread_id),
      mapping.thread_id,
    )
    const p = proof({ answer: reply.body }, `${run}-${"abc"[i]}`)
    assert.deepEqual(
      p.userEntries.map((e: Json) => e.content),
      [input.message.text],
    )
    providers.add(p.providerSessionId)
    assert.equal(
      f.sent.filter(
        (s: Json) =>
          s.chat.id === input.message.chat.id &&
          s.message_thread_id === input.message.message_thread_id,
      ).length,
      1,
    )
  }
  assert.equal(providers.size, 3)
  assert(state.maxOccupancy > 0, "No running Actor occupancy was observed")
  state.initial = db
  state.mapped = mapped
  state.providerIds = [...providers]
  save()
  event(
    "three isolated production Pi tool runs delivered only after exact latest COMPLETED checkpoints",
    { maxOccupancy: state.maxOccupancy, mappings: mapped },
  )
}
async function reuse() {
  const inputs = state.routes.map((r: Json, i: number) =>
    update(state.offset + 20 + i, r.chat, r.thread, `e2e-verify:${run}-${"abc"[i]}`),
  )
  state.reuse = inputs
  await fixture("/__fixture/append", { updates: inputs })
  save()
  await waitDone(inputs.map((u: Json) => u.update_id))
  const { db, f } = await observe()
  assert.deepEqual(
    db.conversations.filter((c: Json) => state.mapped.some((old: Json) => old.key === c.key)),
    state.mapped,
  )
  for (const [i, input] of inputs.entries()) {
    const job = db.jobs.find((j: Json) => Number(j.update_id) === input.update_id)
    const reply = db.outbox.find((o: Json) => o.request_id === job.request_id)
    const p = proof({ answer: reply.body }, `${run}-${"abc"[i]}`)
    assert.deepEqual(
      p.userEntries.map((e: Json) => e.content),
      [state.seeds[i].message.text, input.message.text],
    )
    const initialJob = state.initial.jobs.find(
      (j: Json) => Number(j.update_id) === state.seeds[i].update_id,
    )
    const initialReply = state.initial.outbox.find(
      (o: Json) => o.request_id === initialJob.request_id,
    )
    assert.equal(p.providerSessionId, JSON.parse(initialReply.body).providerSessionId)
    // Exactly one completed initial Pi submission, not another seed run after restart/reuse.
    const calls = f.calls.filter(
      (c: Json) =>
        c.path === "/openai/v1/responses" && latestText(c.body) === state.seeds[i].message.text,
    )
    assert.equal(calls.length, 3)
    assert(
      calls.every(
        (c: Json) =>
          c.headers.authorization === "Bearer fixture-injected-openai-key" &&
          c.headers.session_id === p.providerSessionId &&
          c.body.prompt_cache_key === p.providerSessionId,
      ),
    )
    assert.equal(
      f.calls.filter(
        (c: Json) => c.path === "/openai/v1/responses" && latestText(c.body) === input.message.text,
      ).length,
      2,
    )
  }
  state.final = db
  save()
  event(
    "same mappings, files, raw topic history and provider identities reused; no duplicate finished Pi seed",
  )
}
function latestText(body: Json) {
  const input = body.input?.findLast((i: Json) => i.role === "user")
  return typeof input?.content === "string"
    ? input.content
    : input?.content?.map((p: Json) => p.text ?? "").join("")
}
async function remotePrepare(cold: boolean) {
  const suffix = cold ? "cold" : "memory"
  const marker = `${run}-${cold ? "e" : "d"}`
  let template = templateName
  if (cold) {
    template = `e2e-cold-${run}`
    const original = await client.rpc("getActorTemplate", { actorTemplate: ref(templateName) })
    const expected = ActorTemplate.create({
      ...original,
      metadata: ref(template),
      status: undefined,
      snapshotConfig: {
        ...original.snapshotConfig,
        preferredFidelity: SnapshotFidelity.SNAPSHOT_FIDELITY_VOLUMES,
      },
    })
    // New immutable template only. Never update a sourceTag or upgrade a mapped Actor.
    await client.rpc("createActorTemplate", { actorTemplate: expected })
    await eventually(
      () => client.rpc("getActorTemplate", { actorTemplate: ref(template) }),
      (t) => {
        assert(!t.status?.goldenSnapshotStatus?.errorMessage)
        return Boolean(t.status?.goldenSnapshotStatus?.goldenTag)
      },
    )
  }
  const name = `e2e-${suffix}-${run}`
  const actor = await ensureActor(client, {
    atespace,
    name,
    template: ref(template),
    egress: {
      openAIBaseUrl: `${fixtureOrigin}/openai/v1`,
      llmCredentialUri: process.env.LLM_CREDENTIAL_URI ?? "",
      developmentHosts: ["development-api.telegram-pi-fixtures.svc"],
    },
  })
  const requestId = `telegram:900001:${state.offset + (cold ? 31 : 30)}`
  const receipt = await submit(name, requestId, `e2e-seed:${marker}`)
  const p = proof(receipt, marker)
  const running = await client.rpc("getActor", { actor: ref(name) })
  assert.equal(running.status?.workerAssignment?.workerNamespace, "telegram-pi")
  assert.equal(running.status?.workerAssignment?.workerPool, "telegram-pi")
  assert.equal(p.mainContainsSentinel, false)
  assert.equal(p.walContainsSentinel, true)
  const { quiet, snapshot } = await checkpoint(name)
  assert.equal(quiet.actorUid, actor.metadata?.uid)
  assert.equal(
    snapshot.fidelity,
    cold ? SnapshotFidelity.SNAPSHOT_FIDELITY_VOLUMES : SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY,
  )
  state.remote ??= []
  state.remote.push({
    name,
    marker,
    fidelity: snapshot.fidelity,
    before: quiet,
    snapshot,
    receipt,
    proof: p,
  })
  save()
  event("exact production image captured committed live WAL in private completed remote snapshot", {
    name,
    snapshot,
    image,
  })
}
function remoteItem() {
  const item = state.remote.find((i: Json) => i.name === process.argv[4])
  assert(item)
  return item
}
async function remoteDetach() {
  const item = remoteItem()
  const actor = await client.rpc("getActor", { actor: ref(item.name) })
  assert.deepEqual(plain(latest(actor)), item.snapshot)
  const result = await client.rpc("revertActor", { actor: ref(item.name) }, { timeoutMs: 180_000 })
  assert(result.actor)
  assert.equal(latest(result.actor).uuid, item.snapshot.uuid)
  assert.equal(latest(result.actor).locality, "")
  event("test Actor detached only after latest private COMPLETED receipt, no rollback", {
    name: item.name,
    snapshot: item.snapshot.uuid,
  })
}
async function remoteVerify() {
  const item = remoteItem()
  const receipt = await http(
    item.name,
    `/v1/submissions?requestId=${encodeURIComponent(item.receipt.requestId)}`,
  )
  assert.deepEqual(receipt, item.receipt)
  assert.deepEqual(
    await http(item.name, "/v1/submissions", {
      requestId: item.receipt.requestId,
      text: `e2e-seed:${item.marker}`,
    }),
    item.receipt,
  )
  const q = await http(item.name, "/v1/quiescence")
  for (const key of ["actorUid", "conversationId", "providerSessionId"])
    assert.equal(q[key], item.before[key])
  if (item.fidelity === SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY)
    assert.equal(q.instanceId, item.before.instanceId)
  else assert.notEqual(q.instanceId, item.before.instanceId)
  const verified = await submit(
    item.name,
    `telegram:900001:${state.offset + (item.fidelity === 1 ? 41 : 40)}`,
    `e2e-verify:${item.marker}`,
  )
  const p = proof(verified, item.marker)
  for (const entry of item.proof.userEntries)
    assert(p.userEntries.some((e: Json) => e.id === entry.id && e.content === entry.content))
  for (const id of item.proof.rawEntryIds) assert(p.rawEntryIds.includes(id))
  assert.equal(p.providerSessionId, item.proof.providerSessionId)
  assert.equal(p.conversationId, item.proof.conversationId)
  const f = await fixture()
  const seedCalls = f.calls.filter(
    (c: Json) =>
      c.path === "/openai/v1/responses" && latestText(c.body) === `e2e-seed:${item.marker}`,
  )
  assert.equal(seedCalls.length, 3, "A settled seed was executed again after remote restore")
  const verifyCalls = f.calls.filter(
    (c: Json) =>
      c.path === "/openai/v1/responses" && latestText(c.body) === `e2e-verify:${item.marker}`,
  )
  assert.equal(verifyCalls.length, 2)
  assert(
    [...seedCalls, ...verifyCalls].every(
      (c: Json) =>
        c.headers.authorization === "Bearer fixture-injected-openai-key" &&
        c.headers.session_id === p.providerSessionId &&
        c.body.prompt_cache_key === p.providerSessionId,
    ),
  )
  item.after = { quiet: q, proof: p, receipt: verified }
  save()
  event(
    "actual restore preserves live WAL history, files, Pi submission, provider/root IDs and SQLite integrity",
    { name: item.name, fidelity: item.fidelity, before: item.before, after: q },
  )
}
async function remoteFinish() {
  const item = remoteItem()
  item.final = await checkpoint(item.name)
  save()
  event("restored validation Actor retained at completed checkpoint", {
    name: item.name,
    snapshot: item.final.snapshot,
  })
}
try {
  if (phase === "baseline") await baseline()
  else if (phase === "reject") await reject()
  else if (phase === "admit") await admit()
  else if (phase === "restart-boundary") await restartBoundary()
  else if (phase === "verify") await verify()
  else if (phase === "reuse") await reuse()
  else if (phase === "remote-prepare-memory") await remotePrepare(false)
  else if (phase === "remote-prepare-cold") await remotePrepare(true)
  else if (phase === "remote-detach") await remoteDetach()
  else if (phase === "remote-verify") await remoteVerify()
  else if (phase === "remote-finish") await remoteFinish()
  else if (phase === "final") {
    assert.deepEqual(await database(), state.final)
    assert.equal(state.remote.length, 2)
    assert(state.remote.every((r: Json) => r.after && r.final))
    writeFileSync(`${base}/fixture-final.json`, JSON.stringify(await fixture(), null, 2))
    event("repeat reconciliation retained cursor, all accepted work, mappings and sent outbox")
  } else assert.fail("Unknown E2E phase")
} catch (error) {
  // External exceptions can contain connection strings. Save only our assertion code, no cause.
  console.error(
    JSON.stringify({
      result: "FAIL",
      phase,
      code:
        error instanceof assert.AssertionError
          ? error.message.split("\n")[0]
          : "runtime_operation_failed",
    }),
  )
  process.exitCode = 1
} finally {
  save()
  await client.close()
  await pool.end()
}
