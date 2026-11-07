import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  DeliveryReconciliationRequired,
  splitTelegramText,
  TelegramDelivery,
  type TelegramDeliveryStore,
} from "../src/gateway/delivery.js"
import { migrate } from "../src/gateway/migrations.js"
import { conversationKey, GatewayStore } from "../src/gateway/store.js"
import { TelegramClient } from "../src/gateway/telegram.js"

const ownerUrl = process.env.STORE_TEST_OWNER_URL
const appUrl = process.env.STORE_TEST_APP_URL
if (!ownerUrl || !appUrl)
  throw new Error("Run bash scripts/test-postgres.sh for delivery integration")
const owner = new Pool({ connectionString: ownerUrl })
const app = new Pool({ connectionString: appUrl })
const store = new GatewayStore(app)
const address = { botId: "500", chatId: "-100", threadId: "42" }
const key = conversationKey(address)

function deliveryStore(overrides: Partial<TelegramDeliveryStore>): TelegramDeliveryStore {
  return {
    getConversation: (value) => store.getConversation(value),
    listDeliverableConversations: (botId, limit) =>
      store.listDeliverableConversations(botId, limit),
    claimReply: (value, options) => store.claimReply(value, options),
    getReplyClaim: (value, token) => store.getReplyClaim(value, token),
    getReply: (id) => store.getReply(id),
    markReplySent: (claim, id) => store.markReplySent(claim, id),
    retryReplyKnownFailure: (claim, at, reason) => store.retryReplyKnownFailure(claim, at, reason),
    failReplyKnownFailure: (claim, reason) => store.failReplyKnownFailure(claim, reason),
    markReplyUncertain: (claim, reason) => store.markReplyUncertain(claim, reason),
    ...overrides,
  }
}

async function queueReply(
  chunks = ["fixture answer"],
  options: { checkpoint?: boolean; chatId?: string; threadId?: string | null; botId?: string } = {},
) {
  const route = { ...address, ...options }
  const expectedOffset = await store.getCursor(route.botId)
  const updateId = String(BigInt(expectedOffset) + 1n)
  await store.acceptBatch({
    botId: route.botId,
    expectedOffset,
    nextOffset: String(BigInt(updateId) + 1n),
    updates: [
      { updateId, chatId: route.chatId, threadId: route.threadId, senderId: "7", text: "prompt" },
    ],
  })
  const conversation = conversationKey(route)
  const claimed = await store.claimNext(conversation, { token: randomUUID(), leaseMs: 60_000 })
  if (!claimed) throw new Error("Fixture could not claim queued job")
  const actorUid = claimed.conversation.actorUid ?? randomUUID()
  await store.bindActor(claimed.ownership, actorUid)
  await store.recordAdmissionBaseline(claimed.ownership, String(BigInt(updateId) - 1n))
  await store.markSubmissionAttempted(claimed.ownership)
  await store.recordSubmission(claimed.ownership, `fixture-${updateId}`)
  await store.saveResult(claimed.ownership, {
    submissionId: `fixture-${updateId}`,
    outcome: "succeeded",
    chunks,
  })
  const checkpoint = async () => {
    // This synthetic receipt tests the application gate, not Substrate snapshot fidelity.
    const snapshotId = randomUUID()
    await store.recordSuspendIntent(claimed.ownership, updateId)
    await store.observeSuspendSnapshot(claimed.ownership, { generation: updateId, snapshotId })
    await store.confirmCheckpoint(claimed.ownership, {
      actorName: claimed.conversation.actorName,
      actorUid,
      snapshotId,
      generation: updateId,
      remoteUri: "gs://fixture-only/completed-snapshot",
    })
  }
  if (options.checkpoint !== false) await checkpoint()
  return { requestId: claimed.job.requestId, key: conversation, checkpoint }
}

type SendBody = { chat_id: number; message_thread_id?: number; text: string }
function transport(
  handle?: (body: SendBody, index: number) => unknown | Promise<unknown>,
  saved: TelegramDeliveryStore = store,
  botId = 500,
) {
  const calls: SendBody[] = []
  const client = new TelegramClient({
    token: `${botId}:fixture_only_secret`,
    requestTimeoutMs: 1_000,
    pollTimeoutSeconds: 0,
    fetch: async (url, init) => {
      const method = new URL(url).pathname.split("/").at(-1)
      if (method === "getMe") {
        return Response.json({
          ok: true,
          result: { id: botId, is_bot: true, username: "FixtureBot" },
        })
      }
      if (method !== "sendMessage") throw new Error("Unexpected fixture request")
      const body = JSON.parse(String(init.body)) as SendBody
      calls.push(body)
      const result = handle ? await handle(body, calls.length) : undefined
      if (result instanceof Response) return result
      return Response.json({
        ok: true,
        result: result ?? {
          message_id: 1000 + calls.length,
          chat: { id: body.chat_id },
          ...(body.message_thread_id === undefined
            ? {}
            : { message_thread_id: body.message_thread_id }),
        },
      })
    },
  })
  return { client, delivery: new TelegramDelivery(client, saved), calls }
}

async function expireSending() {
  await owner.query(
    "UPDATE gateway.outbox SET lease_until = clock_timestamp() - interval '1 second' WHERE state = 'sending'",
  )
}

beforeAll(async () => {
  await migrate(owner)
  await owner.query("GRANT USAGE ON SCHEMA gateway TO gateway_app")
  await owner.query(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway TO gateway_app",
  )
  await owner.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway TO gateway_app")
})

beforeEach(async () => {
  await owner.query(
    "TRUNCATE gateway.outbox, gateway.jobs, gateway.inbox, gateway.conversations, gateway.polling_cursors RESTART IDENTITY CASCADE",
  )
})

afterAll(async () => {
  await app.end()
  await owner.end()
})

describe("checkpoint-gated Telegram delivery with real PostgreSQL", () => {
  it("cannot send before the store checkpoint gate and records original chat/topic receipts", async () => {
    const queued = await queueReply(["<b>plain text</b>"], { checkpoint: false })
    const fixture = transport(async () => {
      expect((await store.getJob(queued.requestId))?.state).toBe("completed")
      expect((await store.getOutbox(queued.requestId))[0].state).toBe("sending")
    })
    expect(await fixture.delivery.deliverConversation(key)).toBe("idle")
    expect(fixture.calls).toEqual([])
    expect((await store.getOutbox(queued.requestId))[0].state).toBe("blocked")
    await queued.checkpoint()
    expect(await fixture.delivery.deliverConversation(key)).toBe("sent")
    expect(fixture.calls).toEqual([
      { chat_id: -100, message_thread_id: 42, text: "<b>plain text</b>" },
    ])
    expect((await store.getOutbox(queued.requestId))[0]).toMatchObject({
      state: "sent",
      responseMessageId: "1001",
    })
  })

  it("omits topic routing for saved main/private chats", async () => {
    const queued = await queueReply(["private"], { chatId: "7", threadId: null })
    const fixture = transport()
    expect(await fixture.delivery.deliverConversation(queued.key)).toBe("sent")
    expect(fixture.calls).toEqual([{ chat_id: 7, text: "private" }])
  })

  it("preserves chunk and job order within one conversation", async () => {
    const first = await queueReply(["first-a", "first-b"])
    const second = await queueReply(["second"])
    const fixture = transport()
    for (let index = 0; index < 3; index++) {
      expect(await fixture.delivery.deliverConversation(key)).toBe("sent")
    }
    expect(await fixture.delivery.deliverConversation(key)).toBe("idle")
    expect(fixture.calls.map((call) => call.text)).toEqual(["first-a", "first-b", "second"])
    expect(
      (await store.getOutbox(first.requestId)).map((reply) => reply.responseMessageId),
    ).toEqual(["1001", "1002"])
    expect((await store.getOutbox(second.requestId))[0].responseMessageId).toBe("1003")
  })

  it("honors 429 retry_after without blocking another conversation", async () => {
    const queued = await queueReply(["rate limited"])
    const other = await queueReply(["other topic"], { threadId: "43" })
    const before = Date.now()
    const fixture = transport((body) => {
      if (body.message_thread_id === 42) {
        return Response.json({
          ok: false,
          error_code: 429,
          parameters: { retry_after: 9 },
          description: "fixture",
        })
      }
    })
    expect(await fixture.delivery.deliverConversation(key)).toBe("retry_scheduled")
    const pending = (await store.getOutbox(queued.requestId))[0]
    expect(pending.state).toBe("pending")
    expect(pending.retryAt.getTime()).toBeGreaterThanOrEqual(before + 9_000)
    expect(pending.reason).toBe("telegram_429")
    expect(await fixture.delivery.deliverConversation(key)).toBe("idle")
    expect(await fixture.delivery.deliverConversation(other.key)).toBe("sent")
    expect(fixture.calls).toHaveLength(2)
  })

  it("resumes partial multi-message delivery without repeating saved chunks", async () => {
    const text = `${"a".repeat(4095)}😀${"b".repeat(4096)}end`
    const chunks = splitTelegramText(text)
    const queued = await queueReply(chunks)
    const initial = transport((_body, index) => {
      if (index === 2)
        return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } })
    })
    expect(await initial.delivery.deliverConversation(key)).toBe("sent")
    expect(await initial.delivery.deliverConversation(key)).toBe("retry_scheduled")
    expect(await initial.delivery.deliverConversation(key)).toBe("idle")
    expect((await store.getOutbox(queued.requestId)).map((reply) => reply.state)).toEqual([
      "sent",
      "pending",
      "pending",
    ])
    await owner.query(
      "UPDATE gateway.outbox SET retry_at = clock_timestamp() - interval '1 second' WHERE state = 'pending'",
    )
    const restarted = transport()
    expect(await restarted.delivery.deliverConversation(key)).toBe("sent")
    expect(await restarted.delivery.deliverConversation(key)).toBe("sent")
    expect(restarted.calls.map((call) => call.text)).toEqual(chunks.slice(1))
    expect([initial.calls[0].text, ...restarted.calls.map((call) => call.text)].join("")).toBe(text)
    expect(
      restarted.calls.every((call) => call.text.isWellFormed() && call.text.length <= 4096),
    ).toBe(true)
    expect(
      (await store.getOutbox(queued.requestId)).every((reply) => reply.responseMessageId !== null),
    ).toBe(true)
  })

  it.each([500, 502, 503, 429])(
    "retries a known Telegram ok:false rejection (%i)",
    async (code) => {
      const queued = await queueReply()
      const fixture = transport(() => Response.json({ ok: false, error_code: code }))
      expect(await fixture.delivery.deliverConversation(key)).toBe("retry_scheduled")
      expect((await store.getOutbox(queued.requestId))[0]).toMatchObject({
        state: "pending",
        reason: `telegram_${code}`,
      })
      expect(fixture.calls).toHaveLength(1)
    },
  )

  it.each([400, 401, 403, 409])(
    "retains non-retryable known failures and blocks later chunks (%i)",
    async (code) => {
      const queued = await queueReply(["rejected", "later"])
      const fixture = transport(() =>
        Response.json({ ok: false, error_code: code, description: "500:fixture_only_secret" }),
      )
      expect(await fixture.delivery.deliverConversation(key)).toBe("failed")
      expect(await fixture.delivery.deliverConversation(key)).toBe("idle")
      expect((await store.getOutbox(queued.requestId)).map((reply) => reply.state)).toEqual([
        "failed",
        "pending",
      ])
      expect((await store.getOutbox(queued.requestId))[0].reason).toBe(`telegram_${code}`)
      expect(fixture.calls).toHaveLength(1)
    },
  )

  it.each(["network", "body"])(
    "persists uncertain_delivery for lost %s outcomes, never blindly resends",
    async (fault) => {
      const queued = await queueReply(["uncertain", "later"])
      const fixture = transport(() => {
        if (fault === "network") throw new Error("Synthetic response lost after upstream send")
        return Response.json({ ok: true, result: { ambiguous: true } })
      })
      expect(await fixture.delivery.deliverConversation(key)).toBe("uncertain_delivery")
      const replies = await store.getOutbox(queued.requestId)
      expect(replies[0]).toMatchObject({
        state: "uncertain",
        reason: "telegram_response_unknown",
        responseMessageId: null,
      })
      expect(replies[1].state).toBe("pending")
      const restarted = transport()
      expect(await restarted.delivery.deliverConversation(key)).toBe("idle")
      expect(restarted.calls).toHaveLength(0)
      expect(fixture.calls).toHaveLength(1)
    },
  )

  it("blocks a fresh sender behind an expired sending intent after process loss", async () => {
    const queued = await queueReply(["possibly sent", "later"])
    await store.claimReply(key, { token: randomUUID(), leaseMs: 60_000 })
    await expireSending()
    const restarted = transport()
    expect(await restarted.delivery.deliverConversation(key)).toBe("idle")
    expect((await store.getOutbox(queued.requestId))[0]).toMatchObject({
      state: "uncertain",
      reason: "sender_lost",
    })
    expect(restarted.calls).toEqual([])
  })

  it("reconciles a lost fresh claim commit response before starting its one HTTP send", async () => {
    const queued = await queueReply()
    const saved = deliveryStore({
      claimReply: async (conversation, options) => {
        await store.claimReply(conversation, options)
        throw new Error("Synthetic lost claim COMMIT response")
      },
    })
    const fixture = transport(undefined, saved)
    expect(await fixture.delivery.deliverConversation(key)).toBe("sent")
    expect(fixture.calls).toHaveLength(1)
    expect((await store.getOutbox(queued.requestId))[0].state).toBe("sent")
  })

  it.each(["before", "after"])(
    "rereads receipt state after a failure %s receipt commit; no repeated send",
    async (fault) => {
      const queued = await queueReply()
      let fail = true
      const saved = deliveryStore({
        markReplySent: async (claim, messageId) => {
          if (fail) {
            fail = false
            if (fault === "after") await store.markReplySent(claim, messageId)
            throw new Error("Synthetic receipt storage response loss")
          }
          await store.markReplySent(claim, messageId)
        },
      })
      const fixture = transport(undefined, saved)
      expect(await fixture.delivery.deliverConversation(key)).toBe("sent")
      expect(fixture.calls).toHaveLength(1)
      expect((await store.getOutbox(queued.requestId))[0]).toMatchObject({
        state: "sent",
        responseMessageId: "1001",
      })
      const restarted = transport()
      expect(await restarted.delivery.deliverConversation(key)).toBe("idle")
      expect(restarted.calls).toHaveLength(0)
    },
  )

  it("retains known receipt evidence if persistence stays unavailable, then blocks on restart", async () => {
    const queued = await queueReply()
    const saved = deliveryStore({
      markReplySent: async () => {
        throw new Error("Synthetic store loss")
      },
    })
    const fixture = transport(undefined, saved)
    const failure = await fixture.delivery.deliverConversation(key).catch((error) => error)
    expect(failure).toBeInstanceOf(DeliveryReconciliationRequired)
    expect(failure.responseMessageId).toBe("1001")
    expect(fixture.calls).toHaveLength(1)
    expect((await store.getOutbox(queued.requestId))[0].state).toBe("sending")
    await expireSending()
    const restarted = transport()
    expect(await restarted.delivery.deliverConversation(key)).toBe("idle")
    expect((await store.getOutbox(queued.requestId))[0].state).toBe("uncertain")
    expect(restarted.calls).toHaveLength(0)
  })

  it("serializes concurrent senders through the durable intent", async () => {
    await queueReply(["first", "later"])
    let release!: () => void
    let entered!: () => void
    const sending = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = transport(async () => {
      entered()
      await blocked
    })
    const running = first.delivery.deliverConversation(key)
    await sending
    const second = transport()
    expect(await second.delivery.deliverConversation(key)).toBe("idle")
    expect(second.calls).toEqual([])
    release()
    expect(await running).toBe("sent")
    expect(await second.delivery.deliverConversation(key)).toBe("sent")
    expect(first.calls.map((call) => call.text)).toEqual(["first"])
    expect(second.calls.map((call) => call.text)).toEqual(["later"])
  })

  it("does not send without a confirmed durable intent after a failed claim", async () => {
    const queued = await queueReply()
    const saved = deliveryStore({
      claimReply: async () => {
        throw new Error("Synthetic claim loss")
      },
    })
    const fixture = transport(undefined, saved)
    await expect(fixture.delivery.deliverConversation(key)).rejects.toBeInstanceOf(
      DeliveryReconciliationRequired,
    )
    expect((await store.getOutbox(queued.requestId))[0].state).toBe("pending")
    expect(fixture.calls).toEqual([])
    const restarted = transport()
    expect(await restarted.delivery.deliverConversation(key)).toBe("sent")
    expect(restarted.calls).toHaveLength(1)
  })

  it("returns without claiming work when cancellation was already requested", async () => {
    const queued = await queueReply()
    const controller = new AbortController()
    controller.abort()
    const fixture = transport()
    expect(await fixture.delivery.deliverConversation(key, controller.signal)).toBe("idle")
    expect(fixture.calls).toEqual([])
    expect((await store.getOutbox(queued.requestId))[0].state).toBe("pending")
  })

  it("lists only this Bot's eligible heads so blocked and foreign conversations cannot starve delivery", async () => {
    await queueReply(["blocked"], { checkpoint: false, threadId: "1" })
    const failed = await queueReply(["failed"], { threadId: "2" })
    const failedClaim = await store.claimReply(failed.key, { token: randomUUID(), leaseMs: 60_000 })
    if (!failedClaim) throw new Error("Missing fixture claim")
    await store.failReplyKnownFailure(failedClaim.ownership, "fixture_rejected")
    const uncertain = await queueReply(["uncertain"], { threadId: "3" })
    const uncertainClaim = await store.claimReply(uncertain.key, {
      token: randomUUID(),
      leaseMs: 60_000,
    })
    if (!uncertainClaim) throw new Error("Missing fixture claim")
    await store.markReplyUncertain(uncertainClaim.ownership, "fixture_unknown")
    await queueReply(["other Bot"], { botId: "600" })
    const ready = await queueReply(["ready", "later"], { threadId: "4" })
    expect(await store.listDeliverableConversations("500", 1)).toEqual([ready.key])
    const fixture = transport()
    expect(await fixture.delivery.deliverOnce()).toEqual(["sent"])
    expect(fixture.calls.map((call) => call.text)).toEqual(["ready"])
    expect(await fixture.delivery.deliverOnce()).toEqual(["sent"])
    expect(fixture.calls.map((call) => call.text)).toEqual(["ready", "later"])
    expect(await fixture.delivery.deliverOnce()).toEqual([])
  })

  it("never claims or sends another Bot's outbox", async () => {
    const queued = await queueReply(["other Bot"], { botId: "600" })
    const fixture = transport()
    expect(await fixture.delivery.deliverConversation(queued.key)).toBe("wrong_bot")
    expect((await store.getOutbox(queued.requestId))[0].state).toBe("pending")
    expect(fixture.calls).toEqual([])
  })
})
