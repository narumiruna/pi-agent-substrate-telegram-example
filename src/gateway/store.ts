import { createHash } from "node:crypto"
import type { Pool, PoolClient } from "pg"

/** Decimal strings preserve PostgreSQL/Telegram int64 values without Number conversion. */
export type DecimalId = string
export interface ConversationAddress {
  botId: DecimalId
  chatId: DecimalId
  threadId: DecimalId | null
}
export interface AcceptedUpdate {
  updateId: DecimalId
  chatId: DecimalId
  threadId: DecimalId | null
  senderId: DecimalId
  text: string
}
export interface AcceptedBatch {
  botId: DecimalId
  expectedOffset: DecimalId
  nextOffset: DecimalId
  updates: readonly AcceptedUpdate[]
}
export type JobState =
  | "queued"
  | "running"
  | "result_awaiting_checkpoint"
  | "completed"
  | "failed"
  | "recovery_needed"
export type ActivePhase = "running" | "result_awaiting_checkpoint"
export type FinalOutcome = "succeeded" | "failed" | "cancelled"
export interface Conversation extends ConversationAddress {
  key: string
  actorName: string
  actorUid: string | null
  fence: DecimalId
  ownerToken: string | null
  leaseUntil: Date | null
}
export interface Job {
  requestId: string
  sequence: DecimalId
  conversationKey: string
  state: JobState
  revision: DecimalId
  submissionId: string | null
  submissionAttempted: boolean
  admissionGeneration: DecimalId | null
  suspendGeneration: DecimalId | null
  suspendSnapshotId: string | null
  finalOutcome: FinalOutcome | null
  recoveryFrom: ActivePhase | null
  reason: string | null
  checkpoint: CheckpointReceipt | null
  botId: DecimalId
  updateId: DecimalId
  senderId: DecimalId
  text: string
}
export interface Ownership {
  conversationKey: string
  requestId: string
  token: string
  fence: DecimalId
}
export interface ClaimedJob {
  ownership: Ownership
  conversation: Conversation
  job: Job
}
export interface ClaimOptions {
  /** A new UUID for each claim attempt. Retain it for reconciliation after a lost response. */
  token: string
  leaseMs: number
}
/** Supplied only after external verification of the intended Actor's latest COMPLETED remote snapshot. */
export interface CheckpointReceipt {
  actorName: string
  actorUid: string
  snapshotId: string
  generation: DecimalId
  remoteUri: string
}
export interface FinalResult {
  submissionId: string
  outcome: FinalOutcome
  /** Plain text only, already split for Telegram. No Pi transcript or tool records. */
  chunks: readonly string[]
}
export type ReplyState = "blocked" | "pending" | "sending" | "sent" | "uncertain" | "failed"
export interface Reply {
  id: DecimalId
  requestId: string
  conversationKey: string
  sequence: DecimalId
  chunkIndex: number
  text: string
  state: ReplyState
  revision: DecimalId
  fence: DecimalId
  ownerToken: string | null
  leaseUntil: Date | null
  retryAt: Date
  responseMessageId: DecimalId | null
  reason: string | null
}
export interface ReplyOwnership {
  id: DecimalId
  conversationKey: string
  token: string
  fence: DecimalId
}
export interface ClaimedReply {
  ownership: ReplyOwnership
  reply: Reply
  conversation: Conversation
}

/** A rejected precondition is not permission to repeat an external effect. */
export class StoreConflict extends Error {}
/** No transaction is retried here, including when ROLLBACK succeeds after a lost COMMIT response. */
export class StoreOutcomeUnknown extends Error {
  readonly outcome = "unknown"
  constructor(
    readonly operation: string,
    readonly reconcile: string,
    cause: unknown,
  ) {
    super(`Unknown outcome for ${operation}; ${reconcile}`, { cause })
  }
}

function decimal(value: string, kind: "positive" | "nonnegative" | "signed" = "positive") {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)) {
    throw new Error("IDs must be canonical decimal strings")
  }
  const n = BigInt(value)
  if (
    n < -9223372036854775808n ||
    n > 9223372036854775807n ||
    (kind === "positive" && n <= 0n) ||
    (kind === "nonnegative" && n < 0n) ||
    (kind === "signed" && n === 0n)
  ) {
    throw new Error("ID outside the supported int64 range")
  }
}
function uuid(value: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) {
    throw new Error("Expected a lowercase UUID")
  }
}
function nonempty(value: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected nonempty text")
}
function reasonCode(value: string) {
  // Use stable codes, not exception messages that can contain credentials.
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(value)) throw new Error("Expected a safe reason code")
}
function claimOptions(options: ClaimOptions) {
  uuid(options.token)
  if (
    !Number.isSafeInteger(options.leaseMs) ||
    options.leaseMs < 1 ||
    options.leaseMs > 3_600_000
  ) {
    throw new Error("leaseMs must be an integer from 1 to 3600000")
  }
}
export function conversationKey(address: ConversationAddress): string {
  decimal(address.botId)
  decimal(address.chatId, "signed")
  if (address.threadId !== null) decimal(address.threadId)
  return `telegram:${address.botId}:${address.chatId}:${address.threadId ?? "main"}`
}
export function actorNameForConversation(key: string): string {
  return `tg-${createHash("sha256").update(key).digest("hex").slice(0, 60)}`
}
export function requestIdForUpdate(botId: DecimalId, updateId: DecimalId): string {
  decimal(botId)
  decimal(updateId, "nonnegative")
  return `telegram:${botId}:${updateId}`
}

// Explicit ::text casts also protect callers if another library changes pg's int8 parser.
const conversationColumns = `key, bot_id::text AS "botId", chat_id::text AS "chatId",
  thread_id::text AS "threadId", actor_name AS "actorName", actor_uid::text AS "actorUid", fence::text,
  owner_token::text AS "ownerToken", lease_until AS "leaseUntil"`
const jobColumns = `j.request_id AS "requestId", j.sequence::text, j.conversation_key AS "conversationKey",
  j.state, j.revision::text, j.submission_id AS "submissionId", j.submission_attempted AS "submissionAttempted",
  j.admission_generation::text AS "admissionGeneration", j.suspend_generation::text AS "suspendGeneration",
  j.suspend_snapshot_id::text AS "suspendSnapshotId", j.final_outcome AS "finalOutcome",
  j.recovery_from AS "recoveryFrom", j.reason, j.checkpoint,
  i.bot_id::text AS "botId", i.update_id::text AS "updateId", i.sender_id::text AS "senderId",
  i.input_text AS text`
const replyColumns = `id::text, request_id AS "requestId", conversation_key AS "conversationKey",
  sequence::text, chunk_index AS "chunkIndex", body AS text, state, revision::text, fence::text,
  owner_token::text AS "ownerToken", lease_until AS "leaseUntil", retry_at AS "retryAt",
  response_message_id::text AS "responseMessageId", reason`

export class GatewayStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(
    operation: string,
    reconcile: string,
    fn: (db: PoolClient) => Promise<T>,
  ) {
    let db: PoolClient | undefined
    try {
      db = await this.pool.connect()
      await db.query("BEGIN")
      const result = await fn(db)
      await db.query("COMMIT")
      return result
    } catch (cause) {
      await db?.query("ROLLBACK").catch(() => {})
      if (cause instanceof StoreConflict) throw cause
      throw new StoreOutcomeUnknown(operation, reconcile, cause)
    } finally {
      db?.release()
    }
  }

  async getCursor(botId: DecimalId): Promise<DecimalId> {
    decimal(botId)
    const result = await this.pool.query<{ offset: string }>(
      "SELECT next_offset::text AS offset FROM gateway.polling_cursors WHERE bot_id = $1",
      [botId],
    )
    return result.rows[0]?.offset ?? "0"
  }

  async getConversation(key: string): Promise<Conversation | null> {
    const result = await this.pool.query<Conversation>(
      `SELECT ${conversationColumns} FROM gateway.conversations WHERE key = $1`,
      [key],
    )
    return result.rows[0] ?? null
  }

  private async job(db: Pool | PoolClient, requestId: string): Promise<Job | null> {
    const result = await db.query<Job>(
      `SELECT ${jobColumns} FROM gateway.jobs j JOIN gateway.inbox i USING (request_id)
       WHERE j.request_id = $1`,
      [requestId],
    )
    return result.rows[0] ?? null
  }

  getJob(requestId: string) {
    return this.job(this.pool, requestId)
  }

  /** Re-read this plus getJob after any uncertain claim/mutation. An expired owner is not authority. */
  async getOwnership(key: string): Promise<ClaimedJob | null> {
    // One statement gives a consistent view of ownership and its job.
    const result = await this.pool.query<{ conversation: Conversation; job: Job }>(
      `SELECT row_to_json(c) AS conversation, row_to_json(j) AS job FROM
       (SELECT ${conversationColumns} FROM gateway.conversations WHERE key = $1) c
       JOIN (SELECT ${jobColumns} FROM gateway.jobs j JOIN gateway.inbox i USING(request_id)
         WHERE j.conversation_key = $1 AND j.state IN
           ('running', 'result_awaiting_checkpoint', 'recovery_needed')) j ON true`,
      [key],
    )
    const row = result.rows[0]
    if (!row?.conversation.ownerToken) return null
    // row_to_json timestamps are strings, unlike pg's direct timestamptz decoder.
    const conversation = {
      ...row.conversation,
      leaseUntil: row.conversation.leaseUntil ? new Date(row.conversation.leaseUntil) : null,
    }
    return this.claimed(conversation, row.job)
  }

  async listWork(limit = 100): Promise<string[]> {
    this.limit(limit)
    const result = await this.pool.query<{ key: string }>(
      `SELECT DISTINCT conversation_key AS key FROM gateway.jobs
       WHERE state IN ('queued', 'running', 'result_awaiting_checkpoint', 'recovery_needed')
       ORDER BY key LIMIT $1`,
      [limit],
    )
    return result.rows.map((row) => row.key)
  }

  /** Reattach old work first. Explicit recovery heads are not automatic retry candidates. */
  async listDispatchWork(
    botId: DecimalId,
    limit = 100,
  ): Promise<{ conversation: Conversation; job: Job }[]> {
    decimal(botId)
    this.limit(limit)
    const result = await this.pool.query<{ conversation: Conversation; job: Job }>(
      `SELECT row_to_json(c) AS conversation, row_to_json(head) AS job FROM
       (SELECT ${conversationColumns} FROM gateway.conversations WHERE bot_id = $1) c
       CROSS JOIN LATERAL (
         SELECT ${jobColumns} FROM gateway.jobs j JOIN gateway.inbox i USING(request_id)
         WHERE j.conversation_key = c.key AND j.state IN
           ('queued', 'running', 'result_awaiting_checkpoint', 'recovery_needed')
         ORDER BY j.sequence LIMIT 1
       ) head
       WHERE (c."leaseUntil" IS NULL OR c."leaseUntil" <= clock_timestamp())
         AND (head.state <> 'recovery_needed' OR head.reason IN ('owner_lost', 'checkpoint_pending'))
       ORDER BY (head.state = 'queued'), head.sequence::bigint LIMIT $2`,
      [botId, limit],
    )
    return result.rows.map(({ conversation, job }) => ({
      conversation: {
        ...conversation,
        leaseUntil: conversation.leaseUntil ? new Date(conversation.leaseUntil) : null,
      },
      job,
    }))
  }

  /** Own mapped Actors only. Capacity checks must include Actors left running by a former process. */
  async listMappedActors(botId: DecimalId): Promise<Conversation[]> {
    decimal(botId)
    const result = await this.pool.query<Conversation>(
      `SELECT ${conversationColumns} FROM gateway.conversations WHERE bot_id = $1 AND actor_uid IS NOT NULL ORDER BY key`,
      [botId],
    )
    return result.rows
  }

  private limit(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid limit")
  }

  async acceptBatch(batch: AcceptedBatch): Promise<{
    status: "applied" | "already_applied" | "cursor_conflict"
    cursor: DecimalId
  }> {
    decimal(batch.botId)
    decimal(batch.expectedOffset, "nonnegative")
    decimal(batch.nextOffset, "nonnegative")
    if (BigInt(batch.nextOffset) < BigInt(batch.expectedOffset))
      throw new Error("Cursor regression")
    const updates = [...batch.updates].sort((a, b) =>
      BigInt(a.updateId) < BigInt(b.updateId)
        ? -1
        : BigInt(a.updateId) > BigInt(b.updateId)
          ? 1
          : 0,
    )
    for (const update of updates) {
      conversationKey({ botId: batch.botId, ...update })
      decimal(update.updateId, "nonnegative")
      decimal(update.senderId)
      nonempty(update.text)
      if (
        BigInt(update.updateId) < BigInt(batch.expectedOffset) ||
        BigInt(update.updateId) >= BigInt(batch.nextOffset)
      ) {
        throw new Error("Accepted update outside batch cursor range")
      }
    }
    return this.transaction(
      "acceptBatch",
      "read getCursor and getJob for each accepted requestId",
      async (db) => {
        await db.query(
          "INSERT INTO gateway.polling_cursors(bot_id, next_offset) VALUES ($1, 0) ON CONFLICT DO NOTHING",
          [batch.botId],
        )
        const cursor = (
          await db.query<{ offset: string }>(
            "SELECT next_offset::text AS offset FROM gateway.polling_cursors WHERE bot_id = $1 FOR UPDATE",
            [batch.botId],
          )
        ).rows[0].offset
        if (cursor !== batch.expectedOffset) {
          if (BigInt(cursor) >= BigInt(batch.nextOffset)) {
            for (const update of updates) {
              const existing = await this.job(db, requestIdForUpdate(batch.botId, update.updateId))
              if (!existing) return { status: "cursor_conflict", cursor }
              this.sameInput(existing, batch.botId, update)
            }
            return { status: "already_applied", cursor }
          }
          return { status: "cursor_conflict", cursor }
        }
        for (const update of updates) {
          const key = conversationKey({ botId: batch.botId, ...update })
          const actorName = actorNameForConversation(key)
          await db.query(
            `INSERT INTO gateway.conversations(key, bot_id, chat_id, thread_id, actor_name)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING`,
            [key, batch.botId, update.chatId, update.threadId, actorName],
          )
          const mapping = await this.lockConversation(db, key)
          if (
            mapping.botId !== batch.botId ||
            mapping.chatId !== update.chatId ||
            mapping.threadId !== update.threadId ||
            mapping.actorName !== actorName
          ) {
            throw new StoreConflict("Conversation mapping conflict")
          }
          const requestId = requestIdForUpdate(batch.botId, update.updateId)
          await db.query(
            `INSERT INTO gateway.inbox(request_id, bot_id, update_id, conversation_key, sender_id, input_text)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (bot_id, update_id) DO NOTHING`,
            [requestId, batch.botId, update.updateId, key, update.senderId, update.text],
          )
          await db.query(
            `INSERT INTO gateway.jobs(request_id, sequence, conversation_key)
           SELECT request_id, sequence, conversation_key FROM gateway.inbox WHERE request_id = $1
           ON CONFLICT DO NOTHING`,
            [requestId],
          )
          const existing = await this.job(db, requestId)
          if (!existing) throw new StoreConflict("Inbox/job mismatch")
          this.sameInput(existing, batch.botId, update)
        }
        await db.query("UPDATE gateway.polling_cursors SET next_offset = $2 WHERE bot_id = $1", [
          batch.botId,
          batch.nextOffset,
        ])
        return { status: "applied", cursor: batch.nextOffset }
      },
    )
  }

  private sameInput(job: Job, botId: string, update: AcceptedUpdate) {
    if (
      job.conversationKey !== conversationKey({ botId, ...update }) ||
      job.senderId !== update.senderId ||
      job.text !== update.text
    )
      throw new StoreConflict("Accepted update identity has conflicting content")
  }

  private claimed(conversation: Conversation, job: Job): ClaimedJob {
    if (!conversation.ownerToken) throw new StoreConflict("Conversation has no owner")
    return {
      ownership: {
        conversationKey: conversation.key,
        requestId: job.requestId,
        token: conversation.ownerToken,
        fence: conversation.fence,
      },
      conversation,
      job,
    }
  }

  private async lockConversation(db: PoolClient, key: string): Promise<Conversation> {
    const result = await db.query<Conversation>(
      `SELECT ${conversationColumns} FROM gateway.conversations WHERE key = $1 FOR UPDATE`,
      [key],
    )
    if (!result.rows[0]) throw new StoreConflict("Unknown conversation")
    return result.rows[0]
  }

  private async assertOwner(db: PoolClient, owner: Ownership): Promise<Job> {
    const conversation = await this.lockConversation(db, owner.conversationKey)
    const valid = await db.query(
      `SELECT 1 FROM gateway.conversations WHERE key = $1 AND owner_token = $2 AND fence = $3
       AND lease_until > clock_timestamp()`,
      [owner.conversationKey, owner.token, owner.fence],
    )
    const job = await this.job(db, owner.requestId)
    if (
      !valid.rowCount ||
      !job ||
      job.conversationKey !== conversation.key ||
      !["running", "result_awaiting_checkpoint", "recovery_needed"].includes(job.state)
    ) {
      throw new StoreConflict("Stale ownership fence or inactive job")
    }
    return job
  }

  async claimNext(key: string, options: ClaimOptions): Promise<ClaimedJob | null> {
    claimOptions(options)
    return this.transaction(
      "claimNext",
      "read getOwnership and jobs; match the retained claim token",
      async (db) => {
        const conversation = await this.lockConversation(db, key)
        const active = await db.query<{ requestId: string }>(
          `SELECT request_id AS "requestId" FROM gateway.jobs WHERE conversation_key = $1
         AND state IN ('running', 'result_awaiting_checkpoint', 'recovery_needed')`,
          [key],
        )
        const leased = await db.query(
          "SELECT 1 FROM gateway.conversations WHERE key = $1 AND lease_until > clock_timestamp()",
          [key],
        )
        if (leased.rowCount) {
          if (conversation.ownerToken !== options.token || !active.rows[0]) return null
          const job = await this.job(db, active.rows[0].requestId)
          if (!job) throw new StoreConflict("Active job missing")
          return this.claimed(conversation, job)
        }
        let requestId = active.rows[0]?.requestId
        if (requestId) {
          await db.query(
            `UPDATE gateway.jobs SET recovery_from = CASE WHEN state = 'recovery_needed' THEN recovery_from ELSE state END,
           reason = CASE WHEN state = 'recovery_needed' THEN reason ELSE 'owner_lost' END,
           state = 'recovery_needed', revision = revision + 1 WHERE request_id = $1`,
            [requestId],
          )
        } else {
          const next = await db.query<{ requestId: string }>(
            `SELECT request_id AS "requestId" FROM gateway.jobs WHERE conversation_key = $1 AND state = 'queued'
           ORDER BY sequence LIMIT 1`,
            [key],
          )
          requestId = next.rows[0]?.requestId
          if (!requestId) return null
          await db.query(
            "UPDATE gateway.jobs SET state = 'running', revision = revision + 1 WHERE request_id = $1",
            [requestId],
          )
        }
        const updated = await db.query<Conversation>(
          `UPDATE gateway.conversations SET owner_token = $2, fence = fence + 1,
         lease_until = clock_timestamp() + $3 * interval '1 millisecond' WHERE key = $1
         RETURNING ${conversationColumns}`,
          [key, options.token, options.leaseMs],
        )
        const job = await this.job(db, requestId)
        if (!job) throw new StoreConflict("Claimed job missing")
        return this.claimed(updated.rows[0], job)
      },
    )
  }

  async renew(owner: Ownership, leaseMs: number): Promise<Conversation> {
    claimOptions({ token: owner.token, leaseMs })
    return this.transaction(
      "renew",
      "read getOwnership and compare fence and lease",
      async (db) => {
        await this.assertOwner(db, owner)
        const result = await db.query<Conversation>(
          `UPDATE gateway.conversations SET lease_until = clock_timestamp() + $2 * interval '1 millisecond'
         WHERE key = $1 RETURNING ${conversationColumns}`,
          [owner.conversationKey, leaseMs],
        )
        return result.rows[0]
      },
    )
  }

  private async release(db: PoolClient, key: string) {
    await db.query(
      "UPDATE gateway.conversations SET owner_token = NULL, lease_until = NULL WHERE key = $1",
      [key],
    )
  }

  /** Pin the API record identity before the first Actor POST. A reused name is not the same Actor. */
  async bindActor(owner: Ownership, actorUid: string): Promise<void> {
    uuid(actorUid)
    return this.transaction(
      "bindActor",
      "read getConversation.actorUid and getOwnership",
      async (db) => {
        await this.assertOwner(db, owner)
        const result = await db.query(
          `UPDATE gateway.conversations SET actor_uid = $2 WHERE key = $1
         AND (actor_uid IS NULL OR actor_uid = $2::uuid)`,
          [owner.conversationKey, actorUid],
        )
        if (!result.rowCount) throw new StoreConflict("Actor UID changed; retain recovery evidence")
      },
    )
  }

  /** Record the API generation before any POST. This baseline is immutable for this job. */
  async recordAdmissionBaseline(owner: Ownership, generation: DecimalId): Promise<void> {
    decimal(generation, "nonnegative")
    return this.transaction(
      "recordAdmissionBaseline",
      "read getJob.admissionGeneration",
      async (db) => {
        const job = await this.assertOwner(db, owner)
        if (
          job.state !== "running" ||
          job.submissionAttempted ||
          (job.admissionGeneration !== null && job.admissionGeneration !== generation)
        )
          throw new StoreConflict("Admission baseline conflict")
        await db.query(
          `UPDATE gateway.jobs SET admission_generation = $2, revision = revision + 1 WHERE request_id = $1`,
          [owner.requestId, generation],
        )
      },
    )
  }

  /** Commit the next generation before SuspendActor. Never accept a prior completed snapshot. */
  async recordSuspendIntent(owner: Ownership, generation: DecimalId): Promise<void> {
    decimal(generation)
    return this.transaction("recordSuspendIntent", "read getJob.suspendGeneration", async (db) => {
      const job = await this.assertOwner(db, owner)
      if (
        job.state !== "result_awaiting_checkpoint" ||
        job.admissionGeneration === null ||
        BigInt(generation) !== BigInt(job.admissionGeneration) + 1n ||
        (job.suspendGeneration !== null && job.suspendGeneration !== generation)
      )
        throw new StoreConflict("Suspend intent conflict")
      await db.query(
        `UPDATE gateway.jobs SET suspend_generation = $2, revision = revision + 1 WHERE request_id = $1`,
        [owner.requestId, generation],
      )
    })
  }

  /** Save the observed UUID, including PENDING snapshots, before completion can unlock replies. */
  async observeSuspendSnapshot(
    owner: Ownership,
    snapshot: { generation: DecimalId; snapshotId: string },
  ): Promise<void> {
    decimal(snapshot.generation)
    uuid(snapshot.snapshotId)
    return this.transaction(
      "observeSuspendSnapshot",
      "read getJob.suspendSnapshotId",
      async (db) => {
        const job = await this.assertOwner(db, owner)
        if (
          job.state !== "result_awaiting_checkpoint" ||
          job.suspendGeneration !== snapshot.generation ||
          (job.suspendSnapshotId !== null && job.suspendSnapshotId !== snapshot.snapshotId)
        )
          throw new StoreConflict("Suspend snapshot identity conflict")
        await db.query(
          `UPDATE gateway.jobs SET suspend_snapshot_id = $2, revision = revision + 1 WHERE request_id = $1`,
          [owner.requestId, snapshot.snapshotId],
        )
      },
    )
  }

  /** Persist BEFORE network POST. A true marker without a submission ID is still an uncertain effect. */
  async markSubmissionAttempted(owner: Ownership): Promise<void> {
    return this.transaction(
      "markSubmissionAttempted",
      "read getJob.submissionAttempted and getConversation.actorUid",
      async (db) => {
        const job = await this.assertOwner(db, owner)
        const conversation = await this.lockConversation(db, owner.conversationKey)
        if (
          job.state !== "running" ||
          conversation.actorUid === null ||
          job.admissionGeneration === null
        )
          throw new StoreConflict("Submission requires running job and bound Actor UID")
        if (job.submissionAttempted) return
        await db.query(
          "UPDATE gateway.jobs SET submission_attempted = true, revision = revision + 1 WHERE request_id = $1",
          [owner.requestId],
        )
      },
    )
  }

  async recordSubmission(owner: Ownership, submissionId: string): Promise<void> {
    nonempty(submissionId)
    return this.transaction(
      "recordSubmission",
      "read getJob.submissionId and getOwnership",
      async (db) => {
        const job = await this.assertOwner(db, owner)
        if (
          job.state !== "running" ||
          !job.submissionAttempted ||
          (job.submissionId !== null && job.submissionId !== submissionId)
        ) {
          throw new StoreConflict("Submission identity/state conflict")
        }
        if (job.submissionId === submissionId) return
        await db.query(
          "UPDATE gateway.jobs SET submission_id = $2, revision = revision + 1 WHERE request_id = $1",
          [owner.requestId, submissionId],
        )
      },
    )
  }

  /** Only for a proven failure before submission. Never use this to clear uncertain Actor effects. */
  async failKnown(owner: Ownership, reason: string): Promise<void> {
    reasonCode(reason)
    return this.transaction(
      "failKnown",
      "read getJob.state/reason and getOwnership",
      async (db) => {
        const job = await this.assertOwner(db, owner)
        if (
          (job.state !== "running" &&
            !(job.state === "recovery_needed" && job.recoveryFrom === "running")) ||
          job.submissionAttempted
        ) {
          throw new StoreConflict("Cannot declare submitted work a known admission failure")
        }
        await db.query(
          `UPDATE gateway.jobs SET state = 'failed', recovery_from = NULL, reason = $2,
         revision = revision + 1 WHERE request_id = $1`,
          [owner.requestId, reason],
        )
        await this.release(db, owner.conversationKey)
      },
    )
  }

  async requireRecovery(owner: Ownership, reason: string): Promise<void> {
    reasonCode(reason)
    return this.transaction(
      "requireRecovery",
      "read getJob and getOwnership; do not replay Actor work",
      async (db) => {
        const job = await this.assertOwner(db, owner)
        await db.query(
          `UPDATE gateway.jobs SET state = 'recovery_needed', recovery_from = $2,
         reason = $3, revision = revision + 1 WHERE request_id = $1`,
          [owner.requestId, job.recoveryFrom ?? job.state, reason],
        )
        await this.release(db, owner.conversationKey)
      },
    )
  }

  /** Caller must reconcile persisted Actor status. This authorizes reattachment, not a fresh submission. */
  async resumeReconciled(owner: Ownership, phase: ActivePhase): Promise<void> {
    return this.transaction(
      "resumeReconciled",
      "read getJob.state and getOwnership",
      async (db) => {
        const job = await this.assertOwner(db, owner)
        if (job.state !== "recovery_needed" || job.recoveryFrom !== phase)
          throw new StoreConflict("Recovery phase mismatch")
        await db.query(
          `UPDATE gateway.jobs SET state = $2, recovery_from = NULL, reason = NULL,
         revision = revision + 1 WHERE request_id = $1`,
          [owner.requestId, phase],
        )
      },
    )
  }

  async saveResult(owner: Ownership, result: FinalResult): Promise<void> {
    nonempty(result.submissionId)
    if (!["succeeded", "failed", "cancelled"].includes(result.outcome))
      throw new Error("Invalid final outcome")
    for (const chunk of result.chunks) {
      nonempty(chunk)
      // This is a storage bound, not a Telegram splitting implementation.
      if (chunk.length > 4096) throw new Error("Reply chunk exceeds 4096 UTF-16 units")
    }
    return this.transaction(
      "saveResult",
      "read getJob and getOutbox; blocked replies must not be sent",
      async (db) => {
        const job = await this.assertOwner(db, owner)
        if (job.submissionId !== null && job.submissionId !== result.submissionId)
          throw new StoreConflict("Submission mismatch")
        if (job.state === "result_awaiting_checkpoint") {
          const replies = await this.outbox(db, owner.requestId)
          if (
            job.finalOutcome !== result.outcome ||
            replies.length !== result.chunks.length ||
            replies.some((reply, index) => reply.text !== result.chunks[index])
          )
            throw new StoreConflict("Result conflict")
          return
        }
        if (job.state !== "running" || !job.submissionAttempted)
          throw new StoreConflict("Result requires attempted running job")
        await db.query(
          `UPDATE gateway.jobs SET state = 'result_awaiting_checkpoint', submission_id = $2,
         final_outcome = $3, revision = revision + 1 WHERE request_id = $1`,
          [owner.requestId, result.submissionId, result.outcome],
        )
        for (const [index, chunk] of result.chunks.entries()) {
          await db.query(
            `INSERT INTO gateway.outbox(request_id, conversation_key, sequence, chunk_index, body)
           VALUES ($1, $2, $3, $4, $5)`,
            [owner.requestId, owner.conversationKey, job.sequence, index, chunk],
          )
        }
      },
    )
  }

  /** Persists a caller-verified receipt. The store does not contact Substrate or prove checkpoint fidelity. */
  async confirmCheckpoint(owner: Ownership, receipt: CheckpointReceipt): Promise<void> {
    uuid(receipt.actorUid)
    uuid(receipt.snapshotId)
    decimal(receipt.generation)
    nonempty(receipt.remoteUri)
    return this.transaction(
      "confirmCheckpoint",
      "read getJob.checkpoint/state and getOutbox before delivery",
      async (db) => {
        const conversation = await this.lockConversation(db, owner.conversationKey)
        const job = await this.assertOwner(db, owner)
        if (
          job.state !== "result_awaiting_checkpoint" ||
          receipt.actorName !== conversation.actorName ||
          receipt.actorUid !== conversation.actorUid ||
          job.admissionGeneration === null ||
          receipt.generation !== job.suspendGeneration ||
          receipt.snapshotId !== job.suspendSnapshotId ||
          BigInt(receipt.generation) <= BigInt(job.admissionGeneration)
        ) {
          throw new StoreConflict("Checkpoint Actor/state mismatch")
        }
        await db.query(
          "UPDATE gateway.jobs SET state = 'completed', checkpoint = $2, revision = revision + 1 WHERE request_id = $1",
          [
            owner.requestId,
            JSON.stringify({
              actorName: receipt.actorName,
              actorUid: receipt.actorUid,
              snapshotId: receipt.snapshotId,
              generation: receipt.generation,
              remoteUri: receipt.remoteUri,
            }),
          ],
        )
        await db.query(
          "UPDATE gateway.outbox SET state = 'pending', revision = revision + 1 WHERE request_id = $1 AND state = 'blocked'",
          [owner.requestId],
        )
        await this.release(db, owner.conversationKey)
      },
    )
  }

  private async outbox(db: Pool | PoolClient, requestId: string): Promise<Reply[]> {
    const result = await db.query<Reply>(
      `SELECT ${replyColumns} FROM gateway.outbox WHERE request_id = $1 ORDER BY chunk_index`,
      [requestId],
    )
    return result.rows
  }

  getOutbox(requestId: string): Promise<Reply[]> {
    return this.outbox(this.pool, requestId)
  }

  async getReply(id: DecimalId): Promise<Reply | null> {
    decimal(id)
    const result = await this.pool.query<Reply>(
      `SELECT ${replyColumns} FROM gateway.outbox WHERE id = $1`,
      [id],
    )
    return result.rows[0] ?? null
  }

  async listReplyConversations(limit = 100): Promise<string[]> {
    this.limit(limit)
    const result = await this.pool.query<{ key: string }>(
      `SELECT DISTINCT conversation_key AS key FROM gateway.outbox WHERE state <> 'sent' ORDER BY key LIMIT $1`,
      [limit],
    )
    return result.rows.map((row) => row.key)
  }

  /** Only eligible heads for this Bot. Blocked conversations cannot starve other work. */
  async listDeliverableConversations(botId: DecimalId, limit = 100): Promise<string[]> {
    decimal(botId)
    this.limit(limit)
    const result = await this.pool.query<{ key: string }>(
      `SELECT c.key FROM gateway.conversations c
       CROSS JOIN LATERAL (
         SELECT state, retry_at, lease_until, sequence FROM gateway.outbox
         WHERE conversation_key = c.key AND state <> 'sent'
         ORDER BY sequence, chunk_index LIMIT 1
       ) head
       WHERE c.bot_id = $1 AND (
         (head.state = 'pending' AND head.retry_at <= clock_timestamp()) OR
         (head.state = 'sending' AND head.lease_until <= clock_timestamp())
       )
       ORDER BY head.sequence, c.key LIMIT $2`,
      [botId, limit],
    )
    return result.rows.map((row) => row.key)
  }

  async claimReply(key: string, options: ClaimOptions): Promise<ClaimedReply | null> {
    claimOptions(options)
    return this.transaction(
      "claimReply",
      "read ordered getOutbox/getReply; match token, never repeat an uncertain send",
      async (db) => {
        const conversation = await this.lockConversation(db, key)
        // Earlier blocked/uncertain/sending chunks block all later chunks, including later jobs.
        const first = await db.query<Reply>(
          `SELECT ${replyColumns} FROM gateway.outbox WHERE conversation_key = $1 AND state <> 'sent'
         ORDER BY sequence, chunk_index LIMIT 1 FOR UPDATE`,
          [key],
        )
        let reply = first.rows[0]
        if (
          !reply ||
          reply.state === "blocked" ||
          reply.state === "uncertain" ||
          reply.state === "failed"
        )
          return null
        if (reply.state === "sending") {
          const live = await db.query(
            "SELECT 1 FROM gateway.outbox WHERE id = $1 AND lease_until > clock_timestamp()",
            [reply.id],
          )
          if (!live.rowCount) {
            await db.query(
              `UPDATE gateway.outbox SET state = 'uncertain', owner_token = NULL, lease_until = NULL,
             reason = 'sender_lost', revision = revision + 1 WHERE id = $1`,
              [reply.id],
            )
            return null
          }
          if (reply.ownerToken !== options.token) return null
        } else {
          const ready = await db.query(
            "SELECT 1 FROM gateway.outbox WHERE id = $1 AND retry_at <= clock_timestamp()",
            [reply.id],
          )
          if (!ready.rowCount) return null
          const updated = await db.query<Reply>(
            `UPDATE gateway.outbox SET state = 'sending', owner_token = $2, fence = fence + 1,
           revision = revision + 1, lease_until = clock_timestamp() + $3 * interval '1 millisecond'
           WHERE id = $1 RETURNING ${replyColumns}`,
            [reply.id, options.token, options.leaseMs],
          )
          reply = updated.rows[0]
        }
        return {
          conversation,
          reply,
          ownership: {
            id: reply.id,
            conversationKey: key,
            token: options.token,
            fence: reply.fence,
          },
        }
      },
    )
  }

  /** Read only. Use only with a fresh local token when the caller knows no HTTP send was started.
   * A recovered process must not use an old token to infer non-delivery. Does not renew or reclaim.
   */
  async getReplyClaim(key: string, token: string): Promise<ClaimedReply | null> {
    uuid(token)
    const result = await this.pool.query<{ conversation: Conversation; reply: Reply }>(
      `SELECT row_to_json(c) AS conversation, row_to_json(r) AS reply FROM
       (SELECT ${conversationColumns} FROM gateway.conversations WHERE key = $1) c
       JOIN (SELECT ${replyColumns} FROM gateway.outbox WHERE conversation_key = $1
         AND owner_token = $2 AND state = 'sending' AND lease_until > clock_timestamp()) r ON true`,
      [key, token],
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      conversation: {
        ...row.conversation,
        leaseUntil: row.conversation.leaseUntil ? new Date(row.conversation.leaseUntil) : null,
      },
      reply: {
        ...row.reply,
        leaseUntil: row.reply.leaseUntil ? new Date(row.reply.leaseUntil) : null,
        retryAt: new Date(row.reply.retryAt),
      },
      ownership: { id: row.reply.id, conversationKey: key, token, fence: row.reply.fence },
    }
  }

  private async assertReplyOwner(db: PoolClient, owner: ReplyOwnership) {
    await this.lockConversation(db, owner.conversationKey)
    const result = await db.query(
      `SELECT 1 FROM gateway.outbox WHERE id = $1 AND conversation_key = $2 AND state = 'sending'
       AND owner_token = $3 AND fence = $4 AND lease_until > clock_timestamp()`,
      [owner.id, owner.conversationKey, owner.token, owner.fence],
    )
    if (!result.rowCount) throw new StoreConflict("Stale reply ownership")
  }

  async markReplySent(owner: ReplyOwnership, responseMessageId: DecimalId): Promise<void> {
    decimal(responseMessageId)
    return this.transaction(
      "markReplySent",
      "read getReply responseMessageId/state; a missing acknowledgment is not a failed send",
      async (db) => {
        await this.assertReplyOwner(db, owner)
        await db.query(
          `UPDATE gateway.outbox SET state = 'sent', response_message_id = $2, owner_token = NULL,
         lease_until = NULL, reason = NULL, revision = revision + 1 WHERE id = $1`,
          [owner.id, responseMessageId],
        )
      },
    )
  }

  async retryReplyKnownFailure(
    owner: ReplyOwnership,
    retryAt: Date,
    reason: string,
  ): Promise<void> {
    reasonCode(reason)
    if (!Number.isFinite(retryAt.getTime())) throw new Error("Invalid retryAt")
    return this.transaction(
      "retryReplyKnownFailure",
      "read getReply retryAt/state before another claim",
      async (db) => {
        await this.assertReplyOwner(db, owner)
        await db.query(
          `UPDATE gateway.outbox SET state = 'pending', retry_at = $2, reason = $3,
         owner_token = NULL, lease_until = NULL, revision = revision + 1 WHERE id = $1`,
          [owner.id, retryAt, reason],
        )
      },
    )
  }

  /** A non-retryable known rejection remains visible and blocks later chunks. */
  async failReplyKnownFailure(owner: ReplyOwnership, reason: string): Promise<void> {
    reasonCode(reason)
    return this.transaction(
      "failReplyKnownFailure",
      "read getReply.state/reason; retain the failed chunk",
      async (db) => {
        await this.assertReplyOwner(db, owner)
        await db.query(
          `UPDATE gateway.outbox SET state = 'failed', reason = $2, owner_token = NULL,
         lease_until = NULL, revision = revision + 1 WHERE id = $1`,
          [owner.id, reason],
        )
      },
    )
  }

  async markReplyUncertain(owner: ReplyOwnership, reason: string): Promise<void> {
    reasonCode(reason)
    return this.transaction(
      "markReplyUncertain",
      "read getReply; reconcile the Telegram outcome, do not resend",
      async (db) => {
        await this.assertReplyOwner(db, owner)
        await db.query(
          `UPDATE gateway.outbox SET state = 'uncertain', reason = $2, owner_token = NULL,
         lease_until = NULL, revision = revision + 1 WHERE id = $1`,
          [owner.id, reason],
        )
      },
    )
  }

  /** Explicit operator/transport evidence only. A timeout is not evidence of non-delivery. */
  async resolveUncertainReply(
    id: DecimalId,
    expectedRevision: DecimalId,
    evidenceCode: string,
    resolution: { sent: true; responseMessageId: DecimalId } | { sent: false; retryAt: Date },
  ): Promise<void> {
    decimal(id)
    decimal(expectedRevision, "nonnegative")
    reasonCode(evidenceCode)
    if (resolution.sent) decimal(resolution.responseMessageId)
    else if (!Number.isFinite(resolution.retryAt.getTime())) throw new Error("Invalid retryAt")
    return this.transaction(
      "resolveUncertainReply",
      "read getReply and compare revision/state/response ID",
      async (db) => {
        const found = await db.query<{ key: string }>(
          "SELECT conversation_key AS key FROM gateway.outbox WHERE id = $1",
          [id],
        )
        if (!found.rows[0]) throw new StoreConflict("Unknown reply")
        await this.lockConversation(db, found.rows[0].key)
        const result = await db.query(
          `UPDATE gateway.outbox SET state = $3, response_message_id = $4,
         retry_at = COALESCE($5::timestamptz, retry_at), reason = $6, revision = revision + 1
         WHERE id = $1 AND revision = $2 AND state = 'uncertain'`,
          [
            id,
            expectedRevision,
            resolution.sent ? "sent" : "pending",
            resolution.sent ? resolution.responseMessageId : null,
            resolution.sent ? null : resolution.retryAt,
            evidenceCode,
          ],
        )
        if (!result.rowCount)
          throw new StoreConflict("Reply reconciliation revision/state conflict")
      },
    )
  }
}
