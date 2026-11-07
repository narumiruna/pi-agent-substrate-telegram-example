import { describe, expect, it } from "vitest"
import { conversationKey } from "../src/gateway/store.js"
import {
  type BotIdentity,
  filterTelegramUpdate,
  type PollBatch,
  TelegramApiError,
  TelegramClient,
  type TelegramClientOptions,
  type TelegramFetch,
  TelegramPoller,
  type TelegramPollingStore,
} from "../src/gateway/telegram.js"

const bot: BotIdentity = { id: "500", username: "FixtureBot" }
const token = "500:fixture_only_secret"

function update(id = 1, overrides: Record<string, unknown> = {}) {
  return {
    update_id: id,
    message: {
      message_id: id + 1,
      from: { id: 7, is_bot: false, username: "allowed" },
      chat: { id: 7, type: "private" },
      text: "hello",
      ...overrides,
    },
  }
}

function accepted(value: unknown) {
  return filterTelegramUpdate(value, bot, new Set(["7"]))
}

type Handler = (body: Record<string, unknown>, signal?: AbortSignal | null) => unknown
function fixture(
  handlers: Record<string, Handler> = {},
  options: Partial<TelegramClientOptions> = {},
) {
  const calls: { method: string; body: Record<string, unknown> }[] = []
  const fakeFetch: TelegramFetch = async (url, init) => {
    const method = new URL(url).pathname.split("/").at(-1) ?? ""
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ method, body })
    const result = await (
      handlers[method] ??
      (() => {
        if (method === "getMe") return { id: 500, is_bot: true, username: bot.username }
        if (method === "getWebhookInfo") return { url: "" }
        if (method === "getUpdates") return []
        throw new Error("Unexpected fixture method")
      })
    )(body, init.signal)
    if (result instanceof Response) return result
    return Response.json({ ok: true, result })
  }
  return {
    client: new TelegramClient({ token, fetch: fakeFetch, ...options }),
    calls,
  }
}

class PollStore implements TelegramPollingStore {
  cursor = "0"
  readonly inbox = new Map<string, PollBatch["updates"][number]>()
  readonly batches: PollBatch[] = []
  fault?: "before" | "after"
  beforeCommit?: () => Promise<void>

  async getCursor() {
    return this.cursor
  }

  async getJob(requestId: string) {
    const parts = requestId.split(":")
    const value = this.inbox.get(`${parts[1]}:${parts[2]}`)
    return value
      ? {
          ...value,
          botId: parts[1],
          conversationKey: conversationKey({ botId: parts[1], ...value }),
        }
      : null
  }

  async acceptBatch(batch: PollBatch) {
    this.batches.push(batch)
    await this.beforeCommit?.()
    if (this.fault === "before") {
      this.fault = undefined
      throw new Error("Connection lost before COMMIT")
    }
    if (batch.expectedOffset !== this.cursor) throw new Error("Cursor conflict")
    for (const item of batch.updates) this.inbox.set(`${batch.botId}:${item.updateId}`, item)
    this.cursor = batch.nextOffset
    if (this.fault === "after") {
      this.fault = undefined
      throw new Error("Connection lost after COMMIT")
    }
    return { status: "applied", cursor: this.cursor }
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("Telegram numeric authorization and text triggers", () => {
  it.each(["", " \n\t ", "\u2003", "x".repeat(16_385), "\ud800"])(
    "rejects text the Actor cannot admit",
    (text) => expect(accepted(update(1, { text }))).toBeNull(),
  )
  it("commits a rejected whitespace offset without creating inbox work", async () => {
    const f = fixture({ getUpdates: () => [update(1, { text: " \n\t " })] })
    const store = new PollStore()
    await new TelegramPoller(f.client, store, ["7"]).pollOnce()
    expect(store.cursor).toBe("2")
    expect(store.inbox.size).toBe(0)
  })
  it("accepts private text from the current authorized user, not forwarded attribution", () => {
    expect(accepted(update())).toEqual({
      updateId: "1",
      chatId: "7",
      threadId: null,
      senderId: "7",
      text: "hello",
    })
    expect(
      accepted(update(2, { forward_origin: { type: "user", sender_user: { id: 999 } } })),
    ).not.toBeNull()
    expect(
      accepted(
        update(3, {
          from: { id: 999, is_bot: false, username: "allowed" },
          forward_from: { id: 7 },
          forward_origin: { type: "user", sender_user: { id: 7 } },
        }),
      ),
    ).toBeNull()
  })

  it.each([
    { from: undefined },
    { from: { username: "allowed", is_bot: false } },
    { from: { id: 7, is_bot: true } },
    { from: { id: 7 } },
    { from: { id: "7", is_bot: false } },
    { sender_chat: { id: -99 } },
    { sender_chat: null },
    { is_automatic_forward: true },
    { new_chat_members: [] },
    { forum_topic_created: { name: "service" } },
    { pinned_message: {} },
    { chat: { id: -99, type: "channel" } },
    { text: undefined, caption: "hello" },
    { text: "" },
    { text: "\ud800" },
    { message_thread_id: 0 },
    { message_thread_id: 2.5 },
  ])("rejects anonymous, bot, service, and non-text input: %j", (overrides) => {
    expect(accepted(update(1, overrides))).toBeNull()
  })

  it("accepts update.message only", () => {
    const input = update()
    expect(accepted({ update_id: 1, edited_message: input.message })).toBeNull()
    expect(accepted({ update_id: 1, channel_post: input.message })).toBeNull()
  })

  it("requires an exact entity mention in groups; plain text and other Bots do not trigger", () => {
    const chat = { id: -10, type: "supergroup" }
    expect(accepted(update(1, { chat }))).toBeNull()
    expect(accepted(update(2, { chat, text: "@FixtureBot" }))).toBeNull()
    expect(
      accepted(
        update(3, {
          chat,
          text: "@FixtureBot_evil",
          entities: [{ type: "mention", offset: 0, length: 16 }],
        }),
      ),
    ).toBeNull()
    expect(
      accepted(
        update(3, {
          chat,
          text: "@FixtureBot_evil",
          entities: [{ type: "mention", offset: 0, length: 11 }],
        }),
      ),
    ).toBeNull()
    expect(
      accepted(
        update(4, {
          chat,
          text: "@fixturebot hi",
          entities: [{ type: "mention", offset: 0, length: 11 }],
        }),
      ),
    ).not.toBeNull()
  })

  it("uses UTF-16 offsets after astral characters and validates entity bounds", () => {
    const message = {
      chat: { id: -10, type: "supergroup" },
      message_thread_id: 42,
      text: "😀 @FixtureBot hello",
    }
    expect(
      accepted(update(1, { ...message, entities: [{ type: "mention", offset: 3, length: 11 }] })),
    ).toMatchObject({ chatId: "-10", threadId: "42" })
    for (const [offset, length] of [
      [2, 11],
      [-1, 11],
      [3.5, 11],
      [3, 0],
      [3, 1_000],
      [1_000, 11],
      [Number.MAX_SAFE_INTEGER, 11],
    ]) {
      expect(
        accepted(update(1, { ...message, entities: [{ type: "mention", offset, length }] })),
      ).toBeNull()
    }
  })

  it("triggers replies only by the original Bot numeric ID", () => {
    const message = { chat: { id: -10, type: "group" } }
    expect(
      accepted(update(1, { ...message, reply_to_message: { from: { id: 500, is_bot: true } } })),
    ).not.toBeNull()
    for (const reply of [
      { from: { id: 501, is_bot: true, username: bot.username } },
      { from: { id: 500, is_bot: false } },
      { from: { id: 500, is_bot: true }, sender_chat: { id: -10 } },
      { forward_from: { id: 500 } },
    ]) {
      expect(accepted(update(1, { ...message, reply_to_message: reply }))).toBeNull()
    }
  })
})

describe("sequential Telegram admission", () => {
  it("advances rejected valid updates atomically with accepted messages and deduplicates old batches", async () => {
    const { client, calls } = fixture({
      getUpdates: () => [
        update(8, { from: { id: 999, is_bot: false } }),
        update(7),
        { update_id: 9, edited_message: {} },
      ],
    })
    const store = new PollStore()
    const poller = new TelegramPoller(client, store, ["7"])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(store.cursor).toBe("10")
    expect([...store.inbox.keys()]).toEqual(["500:7"])
    expect(store.batches).toHaveLength(1)
    expect(
      calls.filter((call) => call.method === "getUpdates").map((call) => call.body.offset),
    ).toEqual([0, 10])
    expect(calls.map((call) => call.method)).toEqual([
      "getMe",
      "getWebhookInfo",
      "getUpdates",
      "getUpdates",
    ])
  })

  it("does not acknowledge the next offset until the admission transaction finishes", async () => {
    const committed = deferred()
    const entered = deferred()
    const store = new PollStore()
    store.beforeCommit = async () => {
      entered.resolve()
      await committed.promise
    }
    const { client, calls } = fixture({ getUpdates: () => [update(11)] })
    const poller = new TelegramPoller(client, store, ["7"])
    const first = poller.pollOnce()
    await entered.promise
    await expect(poller.pollOnce()).rejects.toThrow("sequential")
    expect(calls.filter((call) => call.method === "getUpdates")).toHaveLength(1)
    expect(store.cursor).toBe("0")
    committed.resolve()
    await first
    await poller.pollOnce()
    expect(calls.at(-1)?.body.offset).toBe(12)
  })

  it.each(["before", "after"] as const)("reconciles restart %s commit", async (fault) => {
    const store = new PollStore()
    store.fault = fault
    const first = fixture({ getUpdates: () => [update(20)] })
    const initial = new TelegramPoller(first.client, store, ["7"])
    if (fault === "before") await expect(initial.pollOnce()).rejects.toThrow("reconciliation")
    else await initial.pollOnce()
    expect(first.calls.filter((call) => call.method === "getUpdates")).toHaveLength(1)
    const restarted = fixture({ getUpdates: () => [update(20)] })
    await new TelegramPoller(restarted.client, store, ["7"]).pollOnce()
    expect(restarted.calls.at(-1)?.body.offset).toBe(fault === "after" ? 21 : 0)
    expect(store.cursor).toBe("21")
    expect(store.inbox.size).toBe(1)
  })

  it("keeps Bot identity and chat/topic routes stable through token rotation", async () => {
    const store = new PollStore()
    const topics = [
      update(1, { message_thread_id: 2 }),
      update(2, { message_thread_id: 3 }),
      update(3),
    ]
    const first = fixture({ getUpdates: () => topics })
    await new TelegramPoller(first.client, store, ["7"]).pollOnce()
    const rotated = fixture({ getUpdates: () => topics }, { token: "500:rotated_fixture_only" })
    await new TelegramPoller(rotated.client, store, ["7"]).pollOnce()
    expect(store.inbox.size).toBe(3)
    expect([...store.inbox.values()].map((item) => item.threadId)).toEqual(["2", "3", null])
    expect(store.batches[0].botId).toBe("500")
    expect(rotated.calls.at(-1)?.body.offset).toBe(4)
  })

  it("refuses an existing webhook without delete, drop, or polling calls", async () => {
    const { client, calls } = fixture({
      getWebhookInfo: () => ({ url: "https://existing.invalid" }),
    })
    await expect(new TelegramPoller(client, new PollStore(), ["7"]).pollOnce()).rejects.toThrow(
      "webhook exists",
    )
    expect(calls.map((call) => call.method)).toEqual(["getMe", "getWebhookInfo"])
  })

  it("does not advance a cursor for malformed update identifiers", async () => {
    const { client } = fixture({ getUpdates: () => [update(1), { update_id: "2", message: {} }] })
    const store = new PollStore()
    await expect(new TelegramPoller(client, store, ["7"]).pollOnce()).rejects.toThrow(
      TelegramApiError,
    )
    expect(store.cursor).toBe("0")
    expect(store.inbox.size).toBe(0)
  })
})

describe("Telegram transport boundary", () => {
  it("permits deployment-controlled HTTPS fixture URLs but rejects insecure or credential URLs", () => {
    expect(
      () => new TelegramClient({ token, baseUrl: "https://fixture.invalid:9443/api" }),
    ).not.toThrow()
    for (const baseUrl of [
      "http://fixture.invalid",
      "https://user:password@fixture.invalid",
      "https://fixture.invalid?token=secret",
      "https://fixture.invalid/#secret",
      "not a URL",
    ]) {
      expect(() => new TelegramClient({ token, baseUrl })).toThrow("HTTPS")
    }
  })

  it("redacts raw network errors and Telegram descriptions; makes only one write attempt", async () => {
    let calls = 0
    const client = new TelegramClient({
      token,
      fetch: async (url) => {
        calls++
        throw new Error(`Network failure for ${url}`)
      },
    })
    const failure = await client
      .sendMessage({ chatId: "7", threadId: null }, "text")
      .catch((e) => e)
    expect(failure).toBeInstanceOf(TelegramApiError)
    expect(failure.kind).toBe("uncertain")
    expect(String(failure)).not.toContain(token)
    expect(failure.cause).toBeUndefined()
    expect(calls).toBe(1)
    const known = fixture({
      sendMessage: () =>
        Response.json({
          ok: false,
          error_code: 429,
          description: token,
          parameters: { retry_after: 2 },
        }),
    })
    const rejected = await known.client
      .sendMessage({ chatId: "7", threadId: null }, "text")
      .catch((e) => e)
    expect(rejected).toMatchObject({ kind: "known_failure", code: 429, retryAfterSeconds: 2 })
    expect(String(rejected)).not.toContain(token)
  })

  it("supports same-Bot credential rotation but never uses a rotated token for another Bot", async () => {
    let current = token
    const { client, calls } = fixture({}, { token: () => current })
    expect((await client.getMe()).id).toBe("500")
    current = "500:rotated_fixture_secret"
    await client.getUpdates("0")
    expect(calls).toHaveLength(2)
    current = "600:other_bot_fixture_secret"
    await expect(client.getUpdates("0")).rejects.toThrow("verified Bot identity")
    expect(calls).toHaveLength(2)
  })

  it("uses finite cancellation signals and does not follow redirects", async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | null | undefined
    const client = new TelegramClient({
      token,
      requestTimeoutMs: 20,
      pollTimeoutSeconds: 0,
      fetch: async (_url, init) => {
        expect(init.redirect).toBe("error")
        requestSignal = init.signal
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          })
        })
      },
    })
    const request = client.getMe(controller.signal)
    controller.abort()
    await expect(request).rejects.toMatchObject({ kind: "uncertain" })
    expect(requestSignal?.aborted).toBe(true)
    await expect(client.getMe()).rejects.toMatchObject({ kind: "uncertain" })
  })

  it("treats a malformed successful send body or wrong routing as uncertain", async () => {
    for (const result of [
      {},
      { message_id: 12 },
      { message_id: 12, chat: { id: 99 } },
      { message_id: 12, chat: { id: 7 }, message_thread_id: 3 },
    ]) {
      const { client } = fixture({ sendMessage: () => result })
      await expect(
        client.sendMessage({ chatId: "7", threadId: "2" }, "text"),
      ).rejects.toMatchObject({
        kind: "uncertain",
      })
    }
  })
})
