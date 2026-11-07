import { validText } from "../actor/config.js"
import { type AcceptedBatch, type AcceptedUpdate, conversationKey, type Job } from "./store.js"

export interface BotIdentity {
  id: string
  username: string
}

export type AcceptedTelegramUpdate = AcceptedUpdate
export type PollBatch = AcceptedBatch

/** The cursor and accepted inbox records must commit in one transaction. */
export interface TelegramPollingStore {
  getCursor(botId: string): Promise<string>
  acceptBatch(batch: PollBatch): Promise<{ status: string; cursor: string }>
  getJob(
    requestId: string,
  ): Promise<Pick<Job, "botId" | "updateId" | "senderId" | "text" | "conversationKey"> | null>
}

export type TelegramFetch = (url: string, init: RequestInit) => Promise<Response>

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

function chatId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0
}

/** Error text never includes Telegram descriptions, URLs, tokens, or raw network errors. */
export class TelegramApiError extends Error {
  constructor(
    readonly kind: "known_failure" | "uncertain",
    readonly code?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(
      kind === "known_failure"
        ? `Telegram rejected the request${code === undefined ? "" : ` (${code})`}`
        : "Telegram request outcome is unknown",
    )
    this.name = "TelegramApiError"
  }

  get retryable(): boolean {
    return this.kind === "known_failure" && (this.code === 429 || (this.code ?? 0) >= 500)
  }
}

export interface TelegramClientOptions {
  token: string | (() => string)
  /** Deployment-controlled HTTPS origin, not a value supplied by a message. */
  baseUrl?: string
  fetch?: TelegramFetch
  requestTimeoutMs?: number
  pollTimeoutSeconds?: number
}

export interface TelegramRoute {
  chatId: string
  threadId: string | null
}

/** A single HTTP attempt per method. In particular, sends have no hidden retries. */
export class TelegramClient {
  readonly #token: () => string
  readonly #baseUrl: string
  readonly #fetch: TelegramFetch
  readonly #timeoutMs: number
  readonly #pollTimeout: number
  #verifiedBotId?: string

  constructor(options: TelegramClientOptions) {
    const token = options.token
    this.#token = typeof token === "string" ? () => token : token
    let base: URL
    try {
      base = new URL(options.baseUrl ?? "https://api.telegram.org")
    } catch {
      throw new Error("Telegram base URL must be HTTPS")
    }
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
      throw new Error("Telegram base URL must be HTTPS without credentials, query, or fragment")
    }
    this.#baseUrl = base.href.replace(/\/$/, "")
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = options.requestTimeoutMs ?? 40_000
    this.#pollTimeout = options.pollTimeoutSeconds ?? 30
    if (
      !integer(this.#timeoutMs, 1) ||
      this.#timeoutMs > 2_147_483_647 ||
      !integer(this.#pollTimeout, 0) ||
      this.#pollTimeout > 50 ||
      this.#pollTimeout * 1_000 >= this.#timeoutMs
    ) {
      throw new Error("Telegram HTTP timeout must be finite and exceed the polling timeout")
    }
  }

  get requestTimeoutMs(): number {
    return this.#timeoutMs
  }

  async #call(method: string, body: JsonObject, signal?: AbortSignal): Promise<unknown> {
    let token: string
    try {
      token = this.#token()
    } catch {
      throw new Error("Unable to read Telegram token configuration")
    }
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) {
      throw new Error("Invalid Telegram token configuration")
    }
    // The mapping uses getMe, not token text. This check prevents a rotating credential crossing Bots.
    if (this.#verifiedBotId && token.split(":", 1)[0] !== this.#verifiedBotId) {
      throw new Error("Telegram token does not match the verified Bot identity")
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    try {
      const response = await this.#fetch(`${this.#baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      const payload = object(await response.json())
      if (payload?.ok === false) {
        const parameters = object(payload.parameters)
        throw new TelegramApiError(
          "known_failure",
          integer(payload.error_code, 100) && payload.error_code <= 599
            ? payload.error_code
            : undefined,
          integer(parameters?.retry_after, 0) ? parameters.retry_after : undefined,
        )
      }
      if (!response.ok || payload?.ok !== true || !("result" in payload)) {
        throw new TelegramApiError("uncertain")
      }
      return payload.result
    } catch (error) {
      if (error instanceof TelegramApiError) throw error
      // Fetch errors can contain the full token-bearing URL. Do not retain their cause.
      throw new TelegramApiError("uncertain")
    }
  }

  async getMe(signal?: AbortSignal): Promise<BotIdentity> {
    const me = object(await this.#call("getMe", {}, signal))
    if (!integer(me?.id, 1) || me?.is_bot !== true || typeof me.username !== "string") {
      throw new TelegramApiError("uncertain")
    }
    if (!/^[A-Za-z0-9_]+$/.test(me.username)) throw new TelegramApiError("uncertain")
    if (this.#verifiedBotId && this.#verifiedBotId !== String(me.id)) {
      throw new Error("Telegram Bot identity changed")
    }
    this.#verifiedBotId = String(me.id)
    return { id: String(me.id), username: me.username }
  }

  async assertNoWebhook(signal?: AbortSignal): Promise<void> {
    const info = object(await this.#call("getWebhookInfo", {}, signal))
    if (typeof info?.url !== "string") throw new TelegramApiError("uncertain")
    if (info.url !== "") {
      throw new Error("Telegram webhook exists; polling requires an explicit operator transition")
    }
  }

  async getUpdates(offset: string, signal?: AbortSignal): Promise<JsonObject[]> {
    if (!/^(0|[1-9][0-9]*)$/.test(offset) || !Number.isSafeInteger(Number(offset))) {
      throw new Error("Invalid Telegram polling offset")
    }
    const result = await this.#call(
      "getUpdates",
      {
        offset: Number(offset),
        timeout: this.#pollTimeout,
        limit: 100,
        allowed_updates: ["message"],
      },
      signal,
    )
    if (!Array.isArray(result) || result.length > 100) throw new TelegramApiError("uncertain")
    return result.map((value) => {
      const update = object(value)
      if (!update || !integer(update.update_id, 0) || update.update_id >= Number.MAX_SAFE_INTEGER) {
        throw new TelegramApiError("uncertain")
      }
      return update
    })
  }

  async sendMessage(route: TelegramRoute, text: string, signal?: AbortSignal): Promise<string> {
    if (!/^-?[1-9][0-9]*$/.test(route.chatId) || !Number.isSafeInteger(Number(route.chatId))) {
      throw new Error("Invalid saved Telegram chat ID")
    }
    if (
      route.threadId !== null &&
      (!/^[1-9][0-9]*$/.test(route.threadId) || !Number.isSafeInteger(Number(route.threadId)))
    ) {
      throw new Error("Invalid saved Telegram thread ID")
    }
    if (text.length === 0 || text.length > 4096 || !text.isWellFormed()) {
      throw new Error("Telegram text must contain 1 to 4096 well-formed UTF-16 units")
    }
    const result = object(
      await this.#call(
        "sendMessage",
        {
          chat_id: Number(route.chatId),
          ...(route.threadId === null ? {} : { message_thread_id: Number(route.threadId) }),
          text,
        },
        signal,
      ),
    )
    const chat = object(result?.chat)
    if (
      !integer(result?.message_id, 1) ||
      !chatId(chat?.id) ||
      String(chat.id) !== route.chatId ||
      ((route.threadId !== null || result.message_thread_id !== undefined) &&
        String(result.message_thread_id) !== route.threadId)
    ) {
      throw new TelegramApiError("uncertain")
    }
    return String(result.message_id)
  }
}

const serviceFields = [
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "message_auto_delete_timer_changed",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "pinned_message",
  "invoice",
  "successful_payment",
  "refunded_payment",
  "users_shared",
  "chat_shared",
  "connected_website",
  "write_access_allowed",
  "passport_data",
  "proximity_alert_triggered",
  "boost_added",
  "chat_background_set",
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
  "giveaway_created",
  "giveaway",
  "giveaway_winners",
  "giveaway_completed",
  "video_chat_scheduled",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
  "web_app_data",
  "paid_message_price_changed",
]

/** Authorization uses only the identifiable current sender's numeric ID. */
export function filterTelegramUpdate(
  update: unknown,
  bot: BotIdentity,
  allowedSenderIds: ReadonlySet<string>,
): AcceptedTelegramUpdate | null {
  const item = object(update)
  const message = object(item?.message)
  const sender = object(message?.from)
  const chat = object(message?.chat)
  if (
    !integer(item?.update_id, 0) ||
    !integer(message?.message_id, 1) ||
    !integer(sender?.id, 1) ||
    sender?.is_bot !== false ||
    !allowedSenderIds.has(String(sender.id)) ||
    message?.sender_chat !== undefined ||
    message?.is_automatic_forward === true ||
    !chatId(chat?.id) ||
    !["private", "group", "supergroup"].includes(String(chat?.type)) ||
    !validText(message?.text) ||
    serviceFields.some((field) => message[field] !== undefined)
  ) {
    return null
  }
  const thread = message.message_thread_id
  if (thread !== undefined && !integer(thread, 1)) return null
  if (chat.type !== "private") {
    const reply = object(message.reply_to_message)
    const replySender = object(reply?.from)
    const repliesToBot =
      reply?.sender_chat === undefined &&
      integer(replySender?.id, 1) &&
      String(replySender.id) === bot.id &&
      replySender?.is_bot === true
    const text = message.text
    const mentionsBot =
      Array.isArray(message.entities) &&
      message.entities.some((value) => {
        const entity = object(value)
        if (
          entity?.type !== "mention" ||
          !integer(entity.offset, 0) ||
          !integer(entity.length, 1) ||
          entity.offset > text.length - entity.length
        ) {
          return false
        }
        const end = entity.offset + entity.length
        return (
          text.slice(entity.offset, end).toLowerCase() === `@${bot.username.toLowerCase()}` &&
          !/[A-Za-z0-9_]/.test(text.slice(end, end + 1))
        )
      })
    if (!repliesToBot && !mentionsBot) return null
  }
  return {
    updateId: String(item.update_id),
    chatId: String(chat.id),
    threadId: thread === undefined ? null : String(thread),
    senderId: String(sender.id),
    text: message.text,
  }
}

/** No Actor calls occur here. A completed admission transaction permits the next poll. */
export class TelegramPoller {
  #bot?: BotIdentity
  #busy = false
  readonly #allowed: ReadonlySet<string>

  constructor(
    readonly client: TelegramClient,
    readonly store: TelegramPollingStore,
    allowedSenderIds: readonly string[],
  ) {
    if (allowedSenderIds.some((id) => !/^[1-9][0-9]*$/.test(id))) {
      throw new Error("Telegram sender allowlist must contain numeric user IDs")
    }
    this.#allowed = new Set(allowedSenderIds)
  }

  async pollOnce(signal?: AbortSignal): Promise<void> {
    if (this.#busy) throw new Error("Telegram polling must be sequential")
    this.#busy = true
    try {
      if (!this.#bot) {
        const bot = await this.client.getMe(signal)
        await this.client.assertNoWebhook(signal)
        this.#bot = bot
      }
      const bot = this.#bot
      const offset = await this.store.getCursor(bot.id)
      const updates = await this.client.getUpdates(offset, signal)
      const current = updates.filter((update) => Number(update.update_id) >= Number(offset))
      if (current.length === 0) return
      const nextOffset = String(Math.max(...current.map((update) => Number(update.update_id))) + 1)
      const accepted = current
        .sort((a, b) => Number(a.update_id) - Number(b.update_id))
        .map((update) => filterTelegramUpdate(update, bot, this.#allowed))
        .filter((update) => update !== null)
      const batch = { botId: bot.id, expectedOffset: offset, nextOffset, updates: accepted }
      try {
        const result = await this.store.acceptBatch(batch)
        if (result.status !== "applied") await this.#reconcile(batch)
      } catch {
        // A lost COMMIT response is not proof of rollback. Read durable state first.
        await this.#reconcile(batch)
      }
    } finally {
      this.#busy = false
    }
  }

  async #reconcile(batch: PollBatch): Promise<void> {
    const observed = await this.store.getCursor(batch.botId)
    let confirmed = BigInt(observed) >= BigInt(batch.nextOffset)
    for (const update of batch.updates) {
      const job = await this.store.getJob(`telegram:${batch.botId}:${update.updateId}`)
      confirmed &&=
        job !== null &&
        job.botId === batch.botId &&
        job.updateId === update.updateId &&
        job.conversationKey === conversationKey({ botId: batch.botId, ...update }) &&
        job.senderId === update.senderId &&
        job.text === update.text
    }
    if (!confirmed) {
      throw new Error("Telegram admission outcome needs reconciliation; polling stopped")
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) await this.pollOnce(signal)
  }
}
