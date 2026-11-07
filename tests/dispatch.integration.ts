import { randomUUID } from "node:crypto"
import type { AddressInfo } from "node:net"
import { setTimeout as sleep } from "node:timers/promises"
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import { Pool } from "pg"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { actorServer } from "../src/actor/http.js"
import { ActorRuntime } from "../src/actor/runtime.js"
import { gatewayConfig } from "../src/gateway/config.js"
import { type DispatchStore, GatewayDispatcher } from "../src/gateway/dispatch.js"
import { createGateway } from "../src/gateway/index.js"
import { prepareDatabase } from "../src/gateway/migrate.js"
import { migrate, migrations } from "../src/gateway/migrations.js"
import { conversationKey, GatewayStore } from "../src/gateway/store.js"
import { TelegramClient } from "../src/gateway/telegram.js"
import type { ActorResponse, SubstrateClient } from "../src/substrate/client.js"
import { ActorState, SnapshotStorageState } from "../src/substrate/generated/ateapi/v1/ateapi.js"
import { type ensureTemplate, ProvisionConflict } from "../src/substrate/provision.js"
import { fixture as piFixture } from "./actor/helpers.js"
import { actorFixture, atespace, egress, response } from "./dispatch-fixture.js"

const ownerUrl = process.env.STORE_TEST_OWNER_URL
const appUrl = process.env.STORE_TEST_APP_URL
if (!ownerUrl || !appUrl)
  throw new Error("Run bash scripts/test-postgres.sh for dispatch integration")
const owner = new Pool({ connectionString: ownerUrl })
const app = new Pool({ connectionString: appUrl, max: 12 })
const store = new GatewayStore(app)
const botId = "500"
const key = conversationKey({ botId, chatId: "100", threadId: null })
const request = "telegram:500:0"
let fixture = actorFixture()
function dispatcher(saved: DispatchStore = store, capacity = async () => 2) {
  return new GatewayDispatcher({
    store: saved,
    client: fixture.client,
    botId,
    atespace,
    template: "pi-v1",
    egress,
    capacity,
    ensureActor: fixture.ensure,
    leaseMs: 600,
    pollIntervalMs: 5,
    reconciliationMs: 30,
    checkpointWaitMs: 30,
    rpcTimeoutMs: 1000,
  })
}
function statusDispatcher(observe: (next: () => Promise<ActorResponse>) => Promise<ActorResponse>) {
  return new GatewayDispatcher({
    ...dispatcher().options,
    client: {
      ...fixture.client,
      actor: (target, input, wait) => {
        const next = () => fixture.client.actor(target, input, wait)
        return input.method === "GET" && input.path.startsWith("/v1/submissions?")
          ? observe(next)
          : next()
      },
    },
  })
}
async function accept(chats = ["100"], start = 0) {
  await store.acceptBatch({
    botId,
    expectedOffset: String(start),
    nextOffset: String(start + chats.length),
    updates: chats.map((chatId, index) => ({
      chatId,
      threadId: null,
      updateId: String(start + index),
      senderId: "7",
      text: "fixture prompt",
    })),
  })
}
async function expire() {
  await owner.query(
    "UPDATE gateway.conversations SET lease_until = clock_timestamp() - interval '1 second' WHERE owner_token IS NOT NULL",
  )
}
async function seed(attempted = false, result = false, intent = false) {
  const claim = await store.claimNext(key, { token: randomUUID(), leaseMs: 10_000 })
  if (!claim) throw new Error("Missing claim")
  const actor = await fixture.ensure(fixture.client, {
    atespace,
    name: claim.conversation.actorName,
    template: { atespace, name: "pi-v1" },
    egress,
  })
  await store.bindActor(claim.ownership, actor.metadata?.uid ?? "")
  await store.recordAdmissionBaseline(claim.ownership, "1")
  if (attempted) {
    await store.markSubmissionAttempted(claim.ownership)
    await fixture.client.actor(
      { atespace, name: claim.conversation.actorName },
      {
        method: "POST",
        path: "/v1/submissions",
        body: JSON.stringify({ requestId: request, text: claim.job.text }),
      },
    )
    await store.recordSubmission(claim.ownership, "1")
  }
  if (result)
    await store.saveResult(claim.ownership, {
      submissionId: "1",
      outcome: "succeeded",
      chunks: ["fixture answer"],
    })
  if (intent) await store.recordSuspendIntent(claim.ownership, "2")
  return claim
}
function override(overrides: Partial<DispatchStore>): DispatchStore {
  return new Proxy(store, {
    get(target, name) {
      const fn = Reflect.get(overrides, name) ?? Reflect.get(target, name)
      return typeof fn === "function" ? fn.bind(target) : fn
    },
  })
}
/** Real transaction commits/rollbacks, with only its transport acknowledgement removed. */
function loseCommit(operation: keyof DispatchStore, afterCommit: boolean): DispatchStore {
  let first = true
  const brokenPool = {
    connect: async () => {
      const db = await app.connect()
      return {
        query: async (sql: string, values?: unknown[]) => {
          if (sql === "COMMIT") {
            if (afterCommit) await db.query(sql)
            throw new Error("Injected lost COMMIT")
          }
          return db.query(sql, values)
        },
        release: () => db.release(),
      }
    },
  } as unknown as Pool
  const broken = new GatewayStore(brokenPool)
  return new Proxy(store, {
    get(target, name) {
      if (name === operation)
        return (...args: unknown[]) => {
          const receiver = first ? broken : target
          first = false
          return Reflect.apply(Reflect.get(receiver, name), receiver, args)
        }
      const fn = Reflect.get(target, name)
      return typeof fn === "function" ? fn.bind(target) : fn
    },
  })
}
beforeEach(async () => {
  await owner.query("DROP SCHEMA IF EXISTS gateway CASCADE")
  await migrate(owner)
  await owner.query(
    "GRANT USAGE ON SCHEMA gateway TO gateway_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway TO gateway_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway TO gateway_app",
  )
  fixture = actorFixture()
})
afterAll(async () => {
  await app.end()
  await owner.end()
})

describe("serialized dispatch with real PostgreSQL and explicit API/Actor faults", () => {
  it.each([
    [new ProvisionConflict("conflicting immutable Actor"), "actor_provision_conflict"],
    [Object.assign(new Error("permission denied"), { code: 7 }), "actor_provision_denied"],
    [Object.assign(new Error("unauthenticated"), { code: 16 }), "actor_provision_denied"],
  ])("records a permanent pre-submission rejection for manual recovery", async (error, reason) => {
    await accept()
    const dispatch = new GatewayDispatcher({
      ...dispatcher().options,
      ensureActor: async () => {
        throw error
      },
    })
    expect(await dispatch.dispatchConversation(key)).toBe("recovery_needed")
    expect(await store.getJob(request)).toMatchObject({
      state: "recovery_needed",
      reason,
      submissionAttempted: false,
    })
    expect((await store.getConversation(key))?.ownerToken).toBeNull()
    expect(await store.listDispatchWork(botId)).toEqual([])
    expect(fixture.events.filter((event) => event.startsWith("POST"))).toEqual([])
  })
  it("persists UID and intent before POST, result before suspend, and releases/delivers only with matching receipt", async () => {
    await accept()
    fixture.beforeHttp = async () => {
      const job = await store.getJob(request)
      expect(job?.submissionAttempted).toBe(true)
      expect(job?.admissionGeneration).toBe("1")
      expect((await store.getConversation(key))?.actorUid).toBeTruthy()
    }
    fixture.beforeSuspend = async () => {
      expect((await store.getJob(request))?.suspendGeneration).toBe("2")
      expect((await store.getOutbox(request))[0].state).toBe("blocked")
      expect(await store.claimReply(key, { token: randomUUID(), leaseMs: 1000 })).toBeNull()
    }
    expect(await dispatcher().dispatchConversation(key)).toBe("completed")
    const job = await store.getJob(request)
    expect(job?.checkpoint?.generation).toBe("2")
    expect(job?.checkpoint?.snapshotId).toBe(job?.suspendSnapshotId)
    expect((await store.getOutbox(request))[0].state).toBe("pending")
    expect(await store.getOwnership(key)).toBeNull()
  })

  it.each([
    "claimNext",
    "renew",
    "recordAdmissionBaseline",
    "markSubmissionAttempted",
    "recordSubmission",
    "saveResult",
    "recordSuspendIntent",
    "observeSuspendSnapshot",
    "confirmCheckpoint",
  ] as const)(
    "reconciles an actual committed %s whose database response was lost",
    async (operation) => {
      await accept()
      expect(await dispatcher(loseCommit(operation, true)).dispatchConversation(key)).toBe(
        "completed",
      )
      expect(fixture.events.filter((event) => event === "POST /v1/submissions")).toHaveLength(1)
      expect((await store.getJob(request))?.state).toBe("completed")
    },
  )

  it.each([
    "markSubmissionAttempted",
    "saveResult",
    "recordSuspendIntent",
    "confirmCheckpoint",
  ] as const)(
    "reads rollback state before retrying only the safe %s transaction",
    async (operation) => {
      await accept()
      expect(await dispatcher(loseCommit(operation, false)).dispatchConversation(key)).toBe(
        "completed",
      )
      expect(fixture.receipts.size).toBe(1)
    },
  )

  it("reattaches the exact existing Pi submission after a lost POST response, never POSTs again", async () => {
    await accept()
    fixture.postLost = true
    expect(await dispatcher().dispatchConversation(key)).toBe("completed")
    expect(fixture.events.filter((event) => event.startsWith("POST"))).toHaveLength(1)
    expect((await store.getJob(request))?.submissionId).toBe("1")
  })

  it("combines actual Actor HTTP/Pi SQLite with PG recovery and retains the existing Pi submission ID", async () => {
    await accept()
    const f = await piFixture([fauxAssistantMessage("actual Pi answer")], {
      identity: async () => {
        const actor = [...fixture.actors.values()][0]
        return { uid: actor.metadata?.uid ?? "", name: actor.metadata?.name ?? "", atespace }
      },
    })
    const server = actorServer(f.runtime)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    let postedId: string | undefined
    let reopened: ActorRuntime | undefined
    fixture.httpOverride = async (name, input) => {
      const actor = fixture.actors.get(name)
      if (actor?.status) actor.status.state = ActorState.ACTOR_STATE_RUNNING
      const res = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}${input.path}`,
        {
          method: input.method,
          headers: { "content-type": "application/json" },
          body: input.body,
        },
      )
      const body = Buffer.from(await res.arrayBuffer())
      if (input.method === "POST") {
        postedId = (JSON.parse(body.toString()) as { submissionId: string }).submissionId
        throw new Error("Lost actual HTTP POST response after durable admission")
      }
      return { statusCode: res.status, headers: {}, body }
    }
    try {
      expect(await dispatcher(loseCommit("saveResult", true)).dispatchConversation(key)).toBe(
        "completed",
      )
      expect((await store.getJob(request))?.submissionId).toBe(postedId)
      expect((await store.getOutbox(request))[0].text).toBe("actual Pi answer")
      await f.runtime.close()
      reopened = new ActorRuntime(f.options)
      const status = await reopened.status(request)
      expect(status.submissionId).toBe(postedId)
      expect((await reopened.submit(request, "fixture prompt")).submissionId).toBe(postedId)
      expect(f.faux.state.callCount).toBe(1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await reopened?.close()
      await f.cleanup()
    }
  })

  it("does not race concurrent owners or start the next conversation job", async () => {
    await accept(["100", "100"])
    const gate = new AbortController()
    fixture.pendingRuns = true
    const a = dispatcher()
    const b = dispatcher()
    const first = a.dispatchConversation(key, gate.signal)
    await sleep(30)
    expect(await b.dispatchConversation(key)).toBe("idle")
    expect((await store.getJob("telegram:500:1"))?.state).toBe("queued")
    gate.abort()
    expect(await first).toBe("interrupted")
    expect(fixture.receipts.size).toBe(1)
    expect((await store.getJob(request))?.state).toBe("running")
  })

  it("recovers a known-unattempted crash safely, and prioritizes attempted reattachment after restart", async () => {
    await accept(["100", "100"])
    await seed()
    await expire()
    expect(await dispatcher().dispatchConversation(key)).toBe("completed")
    expect((await store.getJob("telegram:500:1"))?.state).toBe("queued")
    expect(fixture.receipts.size).toBe(1)
  })

  it("uses API state before Router status on attempted restart and keeps the stable submission ID", async () => {
    await accept()
    await seed(true)
    await expire()
    fixture.events.length = 0
    expect(await dispatcher().dispatchConversation(key)).toBe("completed")
    expect(fixture.events[0]).toBe("getActor")
    expect(fixture.events).not.toContain("POST /v1/submissions")
    expect((await store.getJob(request))?.submissionId).toBe("1")
  })

  it.each(["disconnect", "json_503", "plain_503", "plain_429"])(
    "reattaches after a late %s status failure without replay or early delivery",
    async (fault) => {
      await accept()
      fixture.pendingRuns = true
      let polls = 0
      const dispatch = statusDispatcher(async (next) => {
        polls++
        if (polls === 1) {
          const pending = await next()
          await sleep(45) // Pending work can exceed the 30 ms absence window.
          return pending
        }
        if (polls === 2) {
          expect((await store.getJob(request))?.submissionId).toBe("1")
          expect(await store.getOutbox(request)).toEqual([])
          expect(fixture.events).not.toContain("suspendActor")
          if (fault === "disconnect") throw new Error("Injected status disconnect")
          if (fault === "json_503") return response({ error: "http_timeout" }, 503)
          return {
            statusCode: fault === "plain_429" ? 429 : 503,
            headers: {},
            body: Buffer.from("Temporarily unavailable"),
          }
        }
        const saved = fixture.receipts.get(request)
        if (!saved) throw new Error("Missing fixture receipt")
        saved.status = "done"
        return next()
      })
      expect(await dispatch.dispatchConversation(key)).toBe("completed")
      expect(polls).toBe(3)
      expect(fixture.events.filter((event) => event === "POST /v1/submissions")).toHaveLength(1)
      expect(await store.getJob(request)).toMatchObject({
        state: "completed",
        submissionId: "1",
        checkpoint: { generation: "2" },
      })
      expect((await store.getOutbox(request))[0].state).toBe("pending")
    },
  )

  it("clears an earlier absence window after a valid pending receipt", async () => {
    await accept()
    fixture.pendingRuns = true
    let polls = 0
    const dispatch = statusDispatcher(async (next) => {
      polls++
      if (polls === 1 || polls === 3) return response({ error: "not_found" }, 404)
      if (polls === 2) {
        const pending = await next()
        await sleep(45)
        return pending
      }
      const saved = fixture.receipts.get(request)
      if (!saved) throw new Error("Missing fixture receipt")
      saved.status = "done"
      return next()
    })
    expect(await dispatch.dispatchConversation(key)).toBe("completed")
    expect(polls).toBe(4)
    expect(fixture.events.filter((event) => event === "POST /v1/submissions")).toHaveLength(1)
  })

  it("does not infer absence from a failed first status request", async () => {
    await accept()
    let polls = 0
    const dispatch = statusDispatcher(async (next) => {
      if (++polls === 1) {
        await sleep(45)
        throw new Error("Injected status disconnect")
      }
      return next()
    })
    expect(await dispatch.dispatchConversation(key)).toBe("completed")
    expect(polls).toBe(2)
    expect(fixture.events.filter((event) => event === "POST /v1/submissions")).toHaveLength(1)
  })

  it("keeps repeated unknown observations interruptible without claiming the request is missing", async () => {
    await accept()
    fixture.pendingRuns = true
    const stop = new AbortController()
    let polls = 0
    const dispatch = statusDispatcher(async (next) => {
      if (++polls === 1) {
        const pending = await next()
        await sleep(45)
        return pending
      }
      if (polls === 3) stop.abort()
      throw new Error("Injected status disconnect")
    })
    expect(await dispatch.dispatchConversation(key, stop.signal)).toBe("interrupted")
    expect(polls).toBe(3)
    expect(await store.getJob(request)).toMatchObject({
      state: "running",
      submissionAttempted: true,
      submissionId: "1",
      admissionGeneration: "1",
    })
    expect(await store.getOutbox(request)).toEqual([])
    expect(fixture.events).not.toContain("suspendActor")
    expect(fixture.events.filter((event) => event === "POST /v1/submissions")).toHaveLength(1)
  })

  it("requires confirmed absence for a new window after long pending work", async () => {
    await accept(["100", "100"])
    fixture.pendingRuns = true
    let polls = 0
    const dispatch = statusDispatcher(async (next) => {
      if (++polls === 1) {
        const pending = await next()
        await sleep(45)
        return pending
      }
      fixture.receipts.delete(request)
      return next()
    })
    expect(await dispatch.dispatchConversation(key)).toBe("recovery_needed")
    expect(polls).toBeGreaterThan(2)
    expect(await store.getJob(request)).toMatchObject({
      state: "recovery_needed",
      reason: "attempted_request_missing",
      submissionAttempted: true,
      submissionId: "1",
      admissionGeneration: "1",
    })
    expect((await store.getConversation(key))?.actorUid).toBeTruthy()
    expect((await store.getJob("telegram:500:1"))?.state).toBe("queued")
    expect(await store.listDispatchWork(botId)).toEqual([])
    expect(await store.getOutbox(request)).toEqual([])
    expect(fixture.events).not.toContain("suspendActor")
    expect(fixture.events.filter((event) => event === "POST /v1/submissions")).toHaveLength(1)
  })

  it("an attempted missing request becomes explicit recovery, with no blind replay", async () => {
    await accept()
    fixture.missingRequest = true
    expect(await dispatcher().dispatchConversation(key)).toBe("recovery_needed")
    expect((await store.getJob(request))?.reason).toBe("attempted_request_missing")
    expect(fixture.events.filter((event) => event.startsWith("POST"))).toHaveLength(1)
    expect(await store.listDispatchWork(botId)).toEqual([])
  })

  it.each(["missing", "changed", "crashed", "suspended"] as const)(
    "blocks %s mapped state without creating or resuming another Actor",
    async (fault) => {
      await accept()
      const claim = await seed(true)
      const actor = fixture.actors.get(claim.conversation.actorName)
      if (!actor?.status || !actor.metadata) throw new Error("Missing fixture Actor")
      if (fault === "missing") fixture.actors.delete(claim.conversation.actorName)
      if (fault === "changed") actor.metadata.uid = randomUUID()
      if (fault === "crashed") actor.status.state = ActorState.ACTOR_STATE_CRASHED
      if (fault === "suspended") actor.status.state = ActorState.ACTOR_STATE_SUSPENDED
      await expire()
      fixture.events.length = 0
      expect(await dispatcher().dispatchConversation(key)).toBe("recovery_needed")
      expect(fixture.events.every((event) => event === "getActor")).toBe(true)
      expect(await store.getOutbox(request)).toEqual([])
    },
  )

  it("Actor recovery_required blocks reply and later work", async () => {
    await accept()
    fixture.recoveryRequired = true
    expect(await dispatcher().dispatchConversation(key)).toBe("recovery_needed")
    expect((await store.getJob(request))?.reason).toBe("actor_recovery_required")
    expect(await store.getOutbox(request)).toEqual([])
    expect(fixture.events).not.toContain("suspendActor")
  })

  it("waits through background compaction and sleeping work before synchronous suspend", async () => {
    await accept()
    fixture.quietAfter = 4
    expect(await dispatcher().dispatchConversation(key)).toBe("completed")
    const suspendIndex = fixture.events.indexOf("suspendActor")
    expect(
      fixture.events.slice(0, suspendIndex).filter((event) => event === "GET /v1/quiescence"),
    ).toHaveLength(5)
  })

  it("renews ownership during bounded HTTP waits; an abort stops waits, not the durable run", async () => {
    await accept()
    fixture.beforeHttp = async () => {
      await sleep(250)
    }
    const d = new GatewayDispatcher({ ...dispatcher().options, leaseMs: 120 })
    expect(await d.dispatchConversation(key)).toBe("completed")
    expect((await store.getJob(request))?.state).toBe("completed")
  })

  it("stops effects when renewal and ownership reads are both unknown", async () => {
    await accept()
    const saved = override({
      renew: async () => {
        throw new Error("disconnect")
      },
      getOwnership: async () => {
        throw new Error("disconnect")
      },
    })
    expect(await dispatcher(saved).dispatchConversation(key)).toBe("interrupted")
    expect(fixture.events).toEqual([])
    expect((await store.getJob(request))?.state).toBe("running")
  })

  it("a lost successful suspend response is reconciled using the exact latest completed receipt", async () => {
    await accept()
    fixture.suspendLost = true
    expect(await dispatcher().dispatchConversation(key)).toBe("completed")
    expect(fixture.events.filter((event) => event === "suspendActor")).toHaveLength(1)
  })

  it("a successful no-op suspend cannot unlock a newer answer using the old completed snapshot", async () => {
    await accept()
    fixture.suspendNoop = true
    expect(await dispatcher().dispatchConversation(key)).toBe("recovery_needed")
    expect((await store.getJob(request))?.reason).toBe("checkpoint_pending")
    expect((await store.getOutbox(request))[0].state).toBe("blocked")
    expect((await store.getJob(request))?.checkpoint).toBeNull()
  })

  it("keeps an asynchronous PENDING snapshot blocked; restart checks API only and unlocks only the recorded UUID", async () => {
    await accept()
    fixture.pendingSnapshot = true
    expect(await dispatcher().dispatchConversation(key)).toBe("recovery_needed")
    const pending = await store.getJob(request)
    expect(pending?.suspendSnapshotId).toBeTruthy()
    expect((await store.getOutbox(request))[0].state).toBe("blocked")
    const actor = [...fixture.actors.values()][0]
    const newest = actor.status?.snapshots.at(-1)
    if (!newest?.durableSnapshot) throw new Error("Missing snapshot")
    newest.durableSnapshot.state = SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED
    newest.durableSnapshot.object = { snapshotUri: "gs://fixture/new" }
    fixture.events.length = 0
    expect(await dispatcher().dispatchConversation(key)).toBe("completed")
    expect(fixture.events.every((event) => event === "getActor")).toBe(true)
    expect((await store.getJob(request))?.checkpoint?.snapshotId).toBe(pending?.suspendSnapshotId)
  })

  it.each(["uuid", "generation"])(
    "does not accept a changed snapshot %s during recovery",
    async (fault) => {
      await accept()
      fixture.pendingSnapshot = true
      await dispatcher().dispatchConversation(key)
      const actor = [...fixture.actors.values()][0]
      const newest = actor.status?.snapshots.at(-1)
      if (!newest) throw new Error("Missing snapshot")
      if (fault === "uuid") newest.uuid = randomUUID()
      else if (actor.status) {
        actor.status.lastAssignedGeneration++
        newest.generation++
      }
      fixture.events.length = 0
      expect(await dispatcher().dispatchConversation(key)).toBe("recovery_needed")
      expect((await store.getJob(request))?.reason).toBe(
        fault === "uuid" ? "checkpoint_snapshot_changed" : "checkpoint_generation_changed",
      )
      expect(fixture.events.every((event) => event === "getActor")).toBe(true)
      expect((await store.getOutbox(request))[0].state).toBe("blocked")
    },
  )

  it("recovers a crash after intent COMMIT but before RPC through API-only synchronous suspend", async () => {
    await accept()
    const stop = new AbortController()
    const saved = override({
      recordSuspendIntent: async (owner, intended) => {
        await store.recordSuspendIntent(owner, intended)
        stop.abort()
      },
    })
    expect(await dispatcher(saved).dispatchConversation(key, stop.signal)).toBe("interrupted")
    expect(fixture.events).not.toContain("suspendActor")
    expect((await store.getJob(request))?.suspendGeneration).toBe("2")
    expect((await store.getJob(request))?.checkpoint).toBeNull()
    expect((await store.getOutbox(request))[0].state).toBe("blocked")
    await expire()
    fixture.events.length = 0
    fixture.beforeSuspend = async () => {
      expect((await store.getOutbox(request))[0].state).toBe("blocked")
      expect((await store.getJob(request))?.checkpoint).toBeNull()
    }
    expect(await dispatcher().dispatchConversation(key)).toBe("completed")
    expect(fixture.events.every((event) => event === "getActor" || event === "suspendActor")).toBe(
      true,
    )
    expect(fixture.events.filter((event) => event === "suspendActor")).toHaveLength(1)
    expect((await store.getJob(request))?.checkpoint?.generation).toBe("2")
    expect((await store.getOutbox(request))[0].state).toBe("pending")
  })

  it("reenters an interrupted SUSPENDING workflow with the same persisted generation and snapshot UUID", async () => {
    await accept()
    fixture.interruptSuspend = true
    expect(await dispatcher().dispatchConversation(key)).toBe("recovery_needed")
    const saved = await store.getJob(request)
    const actor = [...fixture.actors.values()][0]
    expect(actor.status?.state).toBe(ActorState.ACTOR_STATE_SUSPENDING)
    expect(saved?.suspendGeneration).toBe("2")
    expect(saved?.suspendSnapshotId).toBeTruthy()
    expect((await store.getOutbox(request))[0].state).toBe("blocked")
    fixture.interruptSuspend = false
    fixture.events.length = 0
    fixture.beforeSuspend = async () => {
      expect((await store.getJob(request))?.suspendSnapshotId).toBe(saved?.suspendSnapshotId)
    }
    expect(await dispatcher().dispatchConversation(key)).toBe("completed")
    expect(fixture.events.every((event) => event === "getActor" || event === "suspendActor")).toBe(
      true,
    )
    expect(fixture.events.filter((event) => event === "suspendActor")).toHaveLength(1)
    expect(actor.status?.lastAssignedGeneration).toBe(2)
    expect(actor.status?.snapshots).toHaveLength(2)
    expect((await store.getJob(request))?.checkpoint?.snapshotId).toBe(saved?.suspendSnapshotId)
  })

  it("store rejects missing, incorrect next-generation, and unobserved receipts", async () => {
    await accept()
    const claim = await seed(true, true)
    const receipt = {
      actorName: claim.conversation.actorName,
      actorUid: [...fixture.actors.values()][0].metadata?.uid ?? "",
      generation: "2",
      snapshotId: randomUUID(),
      remoteUri: "gs://fixture/new",
    }
    await expect(store.confirmCheckpoint(claim.ownership, receipt)).rejects.toThrow()
    await expect(store.recordSuspendIntent(claim.ownership, "3")).rejects.toThrow()
    await store.recordSuspendIntent(claim.ownership, "2")
    await expect(store.confirmCheckpoint(claim.ownership, receipt)).rejects.toThrow()
    await store.observeSuspendSnapshot(claim.ownership, receipt)
    await expect(
      store.confirmCheckpoint(claim.ownership, { ...receipt, snapshotId: randomUUID() }),
    ).rejects.toThrow()
    await store.confirmCheckpoint(claim.ownership, receipt)
  })

  it("migration of an attempted pre-v3 job blocks unknown admission baseline rather than inventing a receipt", async () => {
    await owner.query("DROP SCHEMA gateway CASCADE")
    await migrate(owner, migrations.slice(0, 2))
    await owner.query(
      "GRANT USAGE ON SCHEMA gateway TO gateway_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway TO gateway_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway TO gateway_app",
    )
    // Insert using the old schema, before the new DTO columns exist.
    await owner.query(
      "INSERT INTO gateway.conversations(key,bot_id,chat_id,actor_name) VALUES($1,500,100,$2)",
      [key, `tg-${"a".repeat(60)}`],
    )
    await owner.query(
      "INSERT INTO gateway.inbox(request_id,bot_id,update_id,conversation_key,sender_id,input_text) VALUES($1,500,0,$2,7,'prompt')",
      [request, key],
    )
    await owner.query(
      "INSERT INTO gateway.jobs(request_id,sequence,conversation_key,state,submission_attempted) SELECT request_id,sequence,conversation_key,'running',true FROM gateway.inbox",
    )
    await migrate(owner)
    expect(await store.getJob(request)).toMatchObject({
      state: "recovery_needed",
      reason: "unknown_admission_baseline",
      admissionGeneration: null,
    })
    expect(await store.listDispatchWork(botId)).toEqual([])
  })

  it("limits new dispatch to two ready workers and accounts for old Running Actors even without local promises", async () => {
    await accept(["100", "200", "300"])
    fixture.pendingRuns = true
    const stop = new AbortController()
    const first = dispatcher()
    expect(await first.dispatchOnce(stop.signal)).toBe(2)
    await sleep(80)
    stop.abort()
    await first.drain()
    await expire()
    const restarted = dispatcher()
    const restartStop = new AbortController()
    expect(await restarted.dispatchOnce(restartStop.signal)).toBe(2)
    await sleep(30)
    expect(fixture.receipts.size).toBe(2)
    expect((await store.getJob("telegram:500:2"))?.state).toBe("queued")
    restartStop.abort()
    await restarted.drain()
  })

  it("direct dispatch also fails closed before Actor creation when capacity is zero", async () => {
    await accept()
    expect(await dispatcher(store, async () => 0).dispatchConversation(key)).toBe("interrupted")
    expect((await store.getJob(request))?.submissionAttempted).toBe(false)
    expect(fixture.events).toEqual([])
  })

  it("zero ready capacity cannot admit a claimed but unattempted job after restart", async () => {
    await accept()
    await seed(false)
    await expire()
    fixture.events.length = 0
    const d = dispatcher(store, async () => 0)
    expect(await d.dispatchOnce()).toBe(0)
    await d.drain()
    expect((await store.getJob(request))?.submissionAttempted).toBe(false)
    expect(fixture.events).toEqual(["getActor"])
    expect(fixture.receipts.size).toBe(0)
  })

  it("capacity failure stops new admission but zero capacity does not prevent old run reattachment", async () => {
    await accept()
    const unavailable = dispatcher(store, async () => {
      throw new Error("unavailable")
    })
    expect(await unavailable.dispatchOnce()).toBe(0)
    expect((await store.getJob(request))?.state).toBe("queued")
    await seed(true)
    await expire()
    const d = dispatcher(store, async () => 0)
    expect(await d.dispatchOnce()).toBe(1)
    await d.drain()
    expect((await store.getJob(request))?.state).toBe("completed")
  })

  it("counts manually blocked Running Actors against capacity but permits progress after a worker is free", async () => {
    await accept(["100", "200", "300"])
    fixture.pendingRuns = true
    const stop = new AbortController()
    const first = dispatcher()
    expect(await first.dispatchOnce(stop.signal)).toBe(2)
    await sleep(60)
    stop.abort()
    await first.drain()
    await expire()
    await owner.query(
      "UPDATE gateway.jobs SET state='recovery_needed',recovery_from='running',reason='operator_required' WHERE state='running'",
    )
    expect(await dispatcher().dispatchOnce()).toBe(0)
    expect((await store.getJob("telegram:500:2"))?.state).toBe("queued")
    const actor = [...fixture.actors.values()][0]
    if (!actor.status) throw new Error("Missing Actor state")
    actor.status.state = ActorState.ACTOR_STATE_SUSPENDED
    fixture.pendingRuns = false
    const d = dispatcher()
    expect(await d.dispatchOnce()).toBe(1)
    await d.drain()
    expect((await store.getJob("telegram:500:2"))?.state).toBe("completed")
  })

  it("runs Gateway admission with real PG leadership, rejects a competing poller, and retains cursor/work across restart", async () => {
    await prepareDatabase(owner, "gateway_app")
    const config = gatewayConfig({
      DATABASE_URL: appUrl,
      TELEGRAM_ALLOWED_USER_IDS: "7",
      POD_NAMESPACE: "fixture",
      SUBSTRATE_ATESPACE: atespace,
      ACTOR_TEMPLATE: "pi-v1",
      ACTOR_IMAGE: `fixture.example/pi@sha256:${"a".repeat(64)}`,
      OPENAI_BASE_URL: egress.openAIBaseUrl,
      OPENAI_MODEL: "gpt-4o-mini",
      OPENAI_MODEL_METADATA: "gpt-4o-mini",
      LLM_CREDENTIAL_URI: egress.llmCredentialUri,
      DEVELOPMENT_HOSTS: "",
    })
    const offsets: number[] = []
    function telegram() {
      return new TelegramClient({
        token: "500:fixture_only",
        requestTimeoutMs: 1000,
        pollTimeoutSeconds: 0,
        fetch: async (url, init) => {
          const method = url.split("/").at(-1)
          if (method === "getMe")
            return Response.json({
              ok: true,
              result: { id: 500, is_bot: true, username: "FixtureBot" },
            })
          if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } })
          const offset = (JSON.parse(String(init.body)) as { offset: number }).offset
          offsets.push(offset)
          if (offset === 0)
            return Response.json({
              ok: true,
              result: [
                {
                  update_id: 0,
                  message: {
                    message_id: 1,
                    chat: { id: 100, type: "private" },
                    from: { id: 7, is_bot: false },
                    text: "accepted before restart",
                  },
                },
              ],
            })
          await new Promise<void>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("stopped")), {
              once: true,
            })
            if (init.signal?.aborted) reject(new Error("stopped"))
          })
          throw new Error("stopped")
        },
      })
    }
    async function gateway() {
      return createGateway(config, {
        healthPort: 0,
        dependencies: {
          pool: new Pool({ connectionString: appUrl, max: 5 }),
          client: { ...fixture.client, close: async () => {} } as SubstrateClient,
          telegram: telegram(),
          capacity: async () => 0,
          ensureTemplate: (async () => ({})) as unknown as typeof ensureTemplate,
        },
      })
    }
    const first = await gateway()
    const second = await gateway()
    try {
      await first.start()
      await expect(second.start()).rejects.toThrow("startup failed")
      for (let i = 0; i < 100 && !(await store.getJob(request)); i++) await sleep(5)
      expect((await store.getJob(request))?.text).toBe("accepted before restart")
      expect(await store.getCursor(botId)).toBe("1")
      await first.close()
      const replacement = await gateway()
      try {
        await replacement.start()
        for (let i = 0; i < 100 && offsets.length < 3; i++) await sleep(5)
        expect(offsets.at(-1)).toBe(1)
        expect(
          (await app.query("SELECT count(*)::int AS count FROM gateway.inbox")).rows[0].count,
        ).toBe(1)
        expect((await store.getJob(request))?.state).toBe("queued")
      } finally {
        await replacement.close()
      }
    } finally {
      await first.close()
      await second.close()
    }
  })

  it("excludes more than 100 manually blocked heads before LIMIT so unrelated conversations can progress", async () => {
    await accept(Array.from({ length: 102 }, (_, index) => String(100 + index)))
    await owner.query(
      "UPDATE gateway.jobs SET state='recovery_needed',recovery_from='running',reason='operator_required' WHERE request_id <> 'telegram:500:101'",
    )
    const d = dispatcher()
    expect(await d.dispatchOnce()).toBe(1)
    await d.drain()
    expect((await store.getJob("telegram:500:101"))?.state).toBe("completed")
  })
})
