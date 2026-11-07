import { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { migrate } from "../src/gateway/migrations.js"
import { conversationKey, GatewayStore } from "../src/gateway/store.js"
import {
  TelegramClient,
  TelegramPoller,
  type TelegramPollingStore,
} from "../src/gateway/telegram.js"

const ownerUrl = process.env.STORE_TEST_OWNER_URL
const appUrl = process.env.STORE_TEST_APP_URL
if (!ownerUrl || !appUrl)
  throw new Error("Run bash scripts/test-postgres.sh for Telegram integration")
const owner = new Pool({ connectionString: ownerUrl })
const app = new Pool({ connectionString: appUrl })
const store = new GatewayStore(app)

function message(id: number, overrides: Record<string, unknown> = {}) {
  return {
    update_id: id,
    message: {
      message_id: id + 1,
      from: { id: 7, is_bot: false },
      chat: { id: -100, type: "supergroup" },
      reply_to_message: { from: { id: 500, is_bot: true } },
      text: "fixture prompt",
      ...overrides,
    },
  }
}

function poller(
  updates: unknown[],
  saved: TelegramPollingStore = store,
  token = "500:fixture_token",
) {
  const offsets: unknown[] = []
  const client = new TelegramClient({
    token,
    fetch: async (url, init) => {
      const method = new URL(url).pathname.split("/").at(-1)
      if (method === "getMe") {
        return Response.json({
          ok: true,
          result: { id: 500, is_bot: true, username: "FixtureBot" },
        })
      }
      if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } })
      if (method !== "getUpdates") throw new Error("Unexpected fixture request")
      offsets.push(JSON.parse(String(init.body)).offset)
      return Response.json({ ok: true, result: updates })
    },
  })
  return { poller: new TelegramPoller(client, saved, ["7"]), offsets }
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

describe("Telegram admission with real PostgreSQL", () => {
  it("atomically admits only authorized triggers, advances rejected updates, and deduplicates repeats", async () => {
    const batch = [
      message(1),
      message(2, { from: { id: 8, is_bot: false } }),
      message(3, { reply_to_message: undefined }),
      message(4, { sender_chat: { id: -100 } }),
      message(5, { forum_topic_created: {} }),
      { update_id: 6, edited_message: message(6).message },
    ]
    const first = poller(batch)
    await first.poller.pollOnce()
    await first.poller.pollOnce()
    expect(first.offsets).toEqual([0, 7])
    expect(await store.getCursor("500")).toBe("7")
    expect((await store.getJob("telegram:500:1"))?.text).toBe("fixture prompt")
    for (const id of [2, 3, 4, 5, 6]) expect(await store.getJob(`telegram:500:${id}`)).toBeNull()
    expect(await store.listWork()).toEqual(["telegram:500:-100:main"])
    const count = await app.query("SELECT count(*)::integer AS count FROM gateway.inbox")
    expect(count.rows[0].count).toBe(1)
  })

  it("restarts after a real transaction rollback without acknowledging lost admission", async () => {
    await owner.query(
      "ALTER TABLE gateway.inbox ADD CONSTRAINT fixture_admission_failure CHECK (input_text <> 'force_failure')",
    )
    const first = poller([message(10, { text: "force_failure" })])
    try {
      await expect(first.poller.pollOnce()).rejects.toThrow("reconciliation")
      expect(first.offsets).toEqual([0])
      expect(await store.getCursor("500")).toBe("0")
      expect(await store.getJob("telegram:500:10")).toBeNull()
    } finally {
      await owner.query("ALTER TABLE gateway.inbox DROP CONSTRAINT fixture_admission_failure")
    }
    const restarted = poller([message(10, { text: "force_failure" })])
    await restarted.poller.pollOnce()
    expect(restarted.offsets).toEqual([0])
    expect(await store.getCursor("500")).toBe("11")
    expect((await store.getJob("telegram:500:10"))?.text).toBe("force_failure")
  })

  it("rereads cursor AND inbox after a lost commit response, then restarts at the saved offset", async () => {
    const droppedResponse: TelegramPollingStore = {
      getCursor: (id) => store.getCursor(id),
      getJob: (id) => store.getJob(id),
      acceptBatch: async (batch) => {
        await store.acceptBatch(batch)
        throw new Error("Synthetic lost transaction response")
      },
    }
    const first = poller([message(11)], droppedResponse)
    await first.poller.pollOnce()
    expect(await store.getCursor("500")).toBe("12")
    const restarted = poller([message(11)])
    await restarted.poller.pollOnce()
    expect(restarted.offsets).toEqual([12])
    const count = await app.query("SELECT count(*)::integer AS count FROM gateway.inbox")
    expect(count.rows[0].count).toBe(1)
  })

  it("never treats a cursor conflict as proof that accepted work committed", async () => {
    await store.acceptBatch({ botId: "500", expectedOffset: "0", nextOffset: "30", updates: [] })
    const stale: TelegramPollingStore = {
      getCursor: async () => "0",
      getJob: (id) => store.getJob(id),
      acceptBatch: (batch) => store.acceptBatch(batch),
    }
    await expect(poller([message(20)], stale).poller.pollOnce()).rejects.toThrow("reconciliation")
    expect(await store.getJob("telegram:500:20")).toBeNull()
  })

  it("preserves separate topic/main mappings and Actor names when the same Bot token rotates", async () => {
    const batch = [
      message(1),
      message(2, { message_thread_id: 2 }),
      message(3, { message_thread_id: 3 }),
    ]
    await poller(batch).poller.pollOnce()
    const before = await Promise.all(
      [null, "2", "3"].map((threadId) =>
        store.getConversation(conversationKey({ botId: "500", chatId: "-100", threadId })),
      ),
    )
    const rotated = poller(batch, store, "500:rotated_fixture_token")
    await rotated.poller.pollOnce()
    expect(rotated.offsets).toEqual([4])
    const after = await Promise.all(before.map((item) => store.getConversation(item?.key ?? "")))
    expect(after).toEqual(before)
    expect(new Set(after.map((item) => item?.actorName)).size).toBe(3)
    expect(after.map((item) => item?.key)).toEqual([
      "telegram:500:-100:main",
      "telegram:500:-100:2",
      "telegram:500:-100:3",
    ])
  })
})
