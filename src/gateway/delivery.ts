import { randomUUID } from "node:crypto"
import type { GatewayStore, Reply, ReplyOwnership } from "./store.js"
import { TelegramApiError, type TelegramClient } from "./telegram.js"

/** Plain text chunks, measured in UTF-16 units as required by Telegram entities. */
export function splitTelegramText(text: string): string[] {
  if (!text.isWellFormed()) throw new Error("Reply text must be well-formed Unicode")
  const chunks: string[] = []
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(offset + 4096, text.length)
    const last = text.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end--
    chunks.push(text.slice(offset, end))
    offset = end
  }
  return chunks
}

export type TelegramDeliveryStore = Pick<
  GatewayStore,
  | "getConversation"
  | "listDeliverableConversations"
  | "claimReply"
  | "getReply"
  | "getReplyClaim"
  | "markReplySent"
  | "retryReplyKnownFailure"
  | "failReplyKnownFailure"
  | "markReplyUncertain"
>

export type DeliveryOutcome =
  | "idle"
  | "wrong_bot"
  | "sent"
  | "retry_scheduled"
  | "failed"
  | "uncertain_delivery"

/** Safe evidence for reconciliation. It does not imply that a store transaction failed. */
export class DeliveryReconciliationRequired extends Error {
  constructor(
    readonly replyId: string | null,
    readonly responseMessageId: string | null = null,
  ) {
    super("Telegram delivery state needs reconciliation; do not resend")
    this.name = "DeliveryReconciliationRequired"
  }
}

/** Delivery is independent of Actor dispatch. Only a durable checkpoint can unlock the store claim. */
export class TelegramDelivery {
  #botId?: string
  readonly #busy = new Set<string>()
  readonly #leaseMs: number

  constructor(
    readonly client: TelegramClient,
    readonly store: TelegramDeliveryStore,
  ) {
    this.#leaseMs = client.requestTimeoutMs + 30_000
    if (this.#leaseMs > 3_600_000)
      throw new Error("Telegram HTTP timeout exceeds the delivery lease bound")
  }

  async deliverConversation(key: string, signal?: AbortSignal): Promise<DeliveryOutcome> {
    if (signal?.aborted || this.#busy.has(key)) return "idle"
    this.#busy.add(key)
    try {
      this.#botId ??= (await this.client.getMe(signal)).id
      const conversation = await this.store.getConversation(key)
      if (!conversation) return "idle"
      if (conversation.botId !== this.#botId) return "wrong_bot"
      const token = randomUUID()
      let claimed: Awaited<ReturnType<TelegramDeliveryStore["claimReply"]>>
      try {
        claimed = await this.store.claimReply(key, { token, leaseMs: this.#leaseMs })
      } catch {
        // This fresh local token has not started HTTP. Read intent; never recover an old token to send.
        try {
          claimed = await this.store.getReplyClaim(key, token)
        } catch {
          throw new DeliveryReconciliationRequired(null)
        }
        if (!claimed) throw new DeliveryReconciliationRequired(null)
      }
      if (!claimed) return "idle"
      const { ownership, reply } = claimed
      if (
        claimed.conversation.botId !== this.#botId ||
        claimed.conversation.key !== key ||
        reply.conversationKey !== key ||
        reply.state !== "sending" ||
        reply.ownerToken !== token ||
        ownership.token !== token ||
        ownership.id !== reply.id ||
        ownership.fence !== reply.fence
      ) {
        await this.#settle(
          ownership,
          () => this.store.markReplyUncertain(ownership, "invalid_send_claim"),
          (stored) => stored.state === "uncertain",
        )
        return "uncertain_delivery"
      }
      if (signal?.aborted) {
        return this.#retry(ownership, new Date(), "send_cancelled_before_request")
      }
      if (
        !reply.leaseUntil ||
        reply.leaseUntil.getTime() <= Date.now() + this.client.requestTimeoutMs
      ) {
        return this.#retry(ownership, new Date(Date.now() + 1_000), "send_lease_short")
      }
      let messageId: string
      try {
        messageId = await this.client.sendMessage(claimed.conversation, reply.text, signal)
      } catch (error) {
        if (error instanceof TelegramApiError && error.kind === "known_failure") {
          const code = `telegram_${error.code ?? "rejected"}`
          if (error.retryable) {
            const retryAt = new Date(Date.now() + (error.retryAfterSeconds ?? 1) * 1_000)
            if (Number.isFinite(retryAt.getTime())) return this.#retry(ownership, retryAt, code)
          }
          await this.#settle(
            ownership,
            () => this.store.failReplyKnownFailure(ownership, code),
            (stored) => stored.state === "failed" && stored.reason === code,
          )
          return "failed"
        }
        // A timeout, lost body, or ambiguous success can follow a successful send.
        await this.#settle(
          ownership,
          () => this.store.markReplyUncertain(ownership, "telegram_response_unknown"),
          (stored) => stored.state === "uncertain",
        )
        return "uncertain_delivery"
      }
      await this.#settle(
        ownership,
        () => this.store.markReplySent(ownership, messageId),
        (stored) => stored.state === "sent" && stored.responseMessageId === messageId,
        messageId,
      )
      return "sent"
    } finally {
      this.#busy.delete(key)
    }
  }

  /** One chunk per conversation. Failed/uncertain heads remain visible and block later replies. */
  async deliverOnce(signal?: AbortSignal): Promise<DeliveryOutcome[]> {
    const outcomes: DeliveryOutcome[] = []
    if (signal?.aborted) return outcomes
    this.#botId ??= (await this.client.getMe(signal)).id
    for (const key of await this.store.listDeliverableConversations(this.#botId)) {
      if (signal?.aborted) break
      outcomes.push(await this.deliverConversation(key, signal))
    }
    return outcomes
  }

  async #retry(owner: ReplyOwnership, retryAt: Date, reason: string): Promise<DeliveryOutcome> {
    await this.#settle(
      owner,
      () => this.store.retryReplyKnownFailure(owner, retryAt, reason),
      (stored) =>
        stored.state === "pending" &&
        stored.reason === reason &&
        stored.retryAt.getTime() === retryAt.getTime(),
    )
    return "retry_scheduled"
  }

  async #settle(
    owner: ReplyOwnership,
    mutate: () => Promise<void>,
    confirmed: (reply: Reply) => boolean,
    responseMessageId: string | null = null,
  ): Promise<void> {
    // Retrying a receipt transaction is safe. Retrying the Telegram write is not.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mutate()
        return
      } catch {
        let stored: Reply | null
        try {
          stored = await this.store.getReply(owner.id)
        } catch {
          throw new DeliveryReconciliationRequired(owner.id, responseMessageId)
        }
        if (stored && confirmed(stored)) return
        if (
          stored?.state !== "sending" ||
          stored.ownerToken !== owner.token ||
          stored.fence !== owner.fence ||
          !stored.leaseUntil ||
          stored.leaseUntil.getTime() <= Date.now()
        ) {
          break
        }
      }
    }
    throw new DeliveryReconciliationRequired(owner.id, responseMessageId)
  }
}
