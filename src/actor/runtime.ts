import { createHash, randomUUID } from "node:crypto"
import { mkdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Models } from "@earendil-works/pi-ai"
import {
  type Conversation,
  ConversationBusy,
  createRegistry,
  defineDoc,
  defineExtension,
  GenerationTask,
  Harness,
  type HarnessOptions,
  hook,
  InboxDoc,
  type ModelRef,
  ProviderDoc,
  ROOT_CONVERSATION_ID,
  type SubmissionRecord,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { type ActorIdentity, LIMITS, validText } from "./config.js"
import { lockDatabase } from "./lock.js"

const context = BACKGROUND_CONTEXT
// RFC 4122 URL namespace. Actor UID supplies uniqueness even if a golden process clones PRNG state.
function actorScopedUuid(uid: string, purpose: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
    .update(`telegram-pi/actor/${uid}/${purpose}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const IdentityDoc = defineDoc<{ uid: string }>({
  kind: "telegram.actor",
  version: 1,
  scope: "session",
  initial: () => ({ uid: "" }),
  checkpointWhen: () => true,
})
const RecoveryDoc = defineDoc<{ toolTaskId?: string; tool?: string }>({
  kind: "telegram.recovery",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen: () => true,
})

export class ActorError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}
export function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^telegram:[1-9][0-9]{0,19}:[0-9]{1,20}$/.test(value)
}
export interface ActorRuntimeOptions {
  dataDir: string
  identity: () => Promise<ActorIdentity>
  model: () => { models: Models; model: ModelRef }
  // Host injection points for deterministic tests. Production supplies no extra extensions or clock.
  harness?: Pick<HarnessOptions, "now" | "setTimer">
  install?: (registry: ReturnType<typeof createRegistry>) => void
}
export interface Receipt {
  requestId?: string
  submissionId: string
  conversationId: string
  status: "pending" | "done" | "unanswered" | "recovery_required"
  piStatus: SubmissionRecord["status"]
  recoveryRequired: boolean
  answer?: string
  reason?: string
}

/** One server process owns one Actor. All admission and initialization share this queue. */
export class ActorRuntime {
  readonly options: ActorRuntimeOptions
  readonly database: string
  readonly workspace: string
  session?: { harness: Harness; root?: Conversation; identity: ActorIdentity; instanceId: string }
  #tail: Promise<unknown> = Promise.resolve()
  #queued = 0
  #closed = false
  #unlock?: () => Promise<void>

  constructor(options: ActorRuntimeOptions) {
    this.options = options
    this.database = resolve(options.dataDir, "pi/session.sqlite")
    this.workspace = resolve(options.dataDir, "workspace")
  }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new ActorError(503, "closed"))
    if (this.#queued >= LIMITS.admissionQueue)
      return Promise.reject(new ActorError(503, "overloaded"))
    this.#queued++
    const pending = this.#tail.then(action)
    this.#tail = pending.catch(() => {})
    return pending.finally(() => {
      this.#queued--
    })
  }

  async #open(create: boolean) {
    const identity = await this.options.identity()
    if (this.session) {
      if (identity.uid !== this.session.identity.uid) throw new ActorError(503, "identity_changed")
      return this.session
    }
    if (!create) {
      try {
        await stat(this.database)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
    }
    let harness: Harness | undefined
    try {
      await mkdir(join(this.database, ".."), { recursive: true })
      try {
        this.#unlock = await lockDatabase(this.database)
      } catch {
        throw new ActorError(503, "already_open")
      }
      await mkdir(this.workspace, { recursive: true })
      const registry = createRegistry()
      const rememberUncertain = async (taskId: string, tool: string) => {
        if (!harness) throw new Error("Harness is not open")
        // Use host context so task cancellation cannot suppress the durable guard.
        await harness.commit(async (tx) => {
          const recovery = await tx.doc(RecoveryDoc)
          recovery.toolTaskId ??= taskId
          recovery.tool ??= tool
        }, context)
      }
      registry.install(CodingTools)
      // Keep built-in replay policies. In 1.5 an interrupted unsafe effect is NOT executed again.
      registry.install(
        defineExtension({
          name: "telegram-limits",
          wraps: (CodingTools.tools ?? []).map((tool) => ({
            tool: tool.name,
            wrap: (resolved: ToolRegistration): ToolRegistration => ({
              ...resolved,
              async execute(args, api, ctx) {
                const env = api.env
                const writeFile = env?.writeFile
                let mutationStarted = false
                // Keep edit validation errors recoverable. Guard only failures after a write starts.
                if (env && writeFile && (tool.name === "write" || tool.name === "edit")) {
                  env.writeFile = (...params) => {
                    mutationStarted = true
                    return writeFile.apply(env, params)
                  }
                }
                try {
                  return await resolved.execute(args, api, ctx)
                } catch (error) {
                  if (mutationStarted) await rememberUncertain(String(api.taskId), tool.name)
                  throw error
                } finally {
                  if (env && writeFile) env.writeFile = writeFile
                }
              },
              outputLimits: {
                maxBytes: LIMITS.toolOutputBytes,
                maxLines: LIMITS.toolOutputLines,
                retain: tool.name === "bash" ? "tail" : "head",
              },
            }),
          })),
          hooks: [
            hook(GenerationTask, {
              beforeProviderRequest: ({ model, payload }) =>
                model.api === "openai-responses"
                  ? {
                      payload: {
                        ...(payload as object),
                        max_output_tokens: LIMITS.modelOutputTokens,
                      },
                    }
                  : undefined,
            }),
            hook(ToolTask, {
              beforeTool: async (call, api, ctx) => {
                if ((await api.snapshot(RecoveryDoc, ctx))?.toolTaskId)
                  return { block: "Uncertain interrupted effect requires operator recovery" }
                if (call.name !== "bash") return undefined
                const timeout = call.arguments.timeout
                if (
                  timeout !== undefined &&
                  (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
                ) {
                  return { block: "Invalid bash timeout" }
                }
                return {
                  arguments: {
                    ...call.arguments,
                    timeout: Math.min(
                      (timeout as number) ?? LIMITS.bashTimeoutSeconds,
                      LIMITS.bashTimeoutSeconds,
                    ),
                  },
                }
              },
              afterTool: async (call, result, api) => {
                if (
                  result.diagnostics?.some(
                    (item) =>
                      item.code === "interrupted" ||
                      item.code === "restart_limit" ||
                      (item.code === "tool_error" && call.name === "bash"),
                  )
                ) {
                  // Unsafe tool failures can follow partial effects (including shell timeout).
                  // Fail closed before Pi publishes the result or asks the model for more tools.
                  await rememberUncertain(String(api.taskId), call.name)
                }
                return undefined
              },
            }),
          ],
        }),
      )
      this.options.install?.(registry)
      const configured = this.options.model()
      const storage = await openNodeSqliteStorage(this.database)
      try {
        harness = await Harness.open(
          storage,
          {
            ...this.options.harness,
            models: configured.models,
            registry,
            env: () => new NodeExecutionEnv({ cwd: this.workspace }),
            settings: {
              stream: { timeoutMs: LIMITS.streamTimeoutMs, maxRetries: 0 },
              retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000, maxAgentDelayMs: 10_000 },
              restartLimit: 3,
              afterFailedRun: "withdraw",
              toolExecution: "sequential",
              compaction: { reserveTokens: 8192, keepRecentTokens: 4096, backgroundTokens: 8192 },
            },
          },
          context,
        )
      } catch (error) {
        await storage.close(context)
        throw error
      }
      const saved = await harness.snapshot(IdentityDoc, context)
      if (saved?.uid && saved.uid !== identity.uid) throw new ActorError(503, "identity_mismatch")
      const existing = await harness.commit((tx) => tx.conversation(ROOT_CONVERSATION_ID), context)
      const root = existing ? await harness.conversation(existing.id, context) : undefined
      // Detect saved unsafe intent before scheduling. This also covers repeated crashes in an afterTool hook.
      const interrupted = (await harness.inspect(context)).tasks.find(({ record }) => {
        const checkpoint = record.state.checkpoint
        return (
          record.kind === "pi.tool" &&
          checkpoint &&
          typeof checkpoint === "object" &&
          !Array.isArray(checkpoint) &&
          checkpoint.phase === "execute" &&
          checkpoint.replay !== "safe"
        )
      })
      if (interrupted) {
        await harness.commit(async (tx) => {
          const recovery = await tx.doc(RecoveryDoc)
          recovery.toolTaskId ??= String(interrupted.record.id)
        }, context)
      }
      this.session = {
        harness,
        root,
        identity,
        instanceId: actorScopedUuid(
          identity.uid,
          `runtime/${randomUUID({ disableEntropyCache: true })}`,
        ),
      }
      // Status can recover EXISTING work, but can never create a root or admission.
      if (root) harness.resume()
      return this.session
    } catch (error) {
      await harness?.close(context)
      await this.#unlock?.()
      this.#unlock = undefined
      throw error
    }
  }

  async #receipt(record: SubmissionRecord): Promise<Receipt> {
    if (!this.session) throw new ActorError(503, "not_initialized")
    const { harness } = this.session
    const recovery = await harness.snapshot(RecoveryDoc, context)
    const result: Receipt = {
      requestId: record.requestId,
      submissionId: String(record.id),
      conversationId: String(record.conversationId),
      piStatus: record.status,
      recoveryRequired: Boolean(recovery?.toolTaskId),
      status:
        record.status === "done" || record.status === "unanswered"
          ? recovery?.toolTaskId
            ? "recovery_required"
            : record.status
          : "pending",
    }
    if (result.status === "done" && record.type === "input" && record.status === "done") {
      const entry = await harness.commit((tx) => tx.entry(record.answer), context)
      const message = entry?.model?.[0]
      if (message?.role === "assistant")
        result.answer = message.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n")
    }
    if (record.status === "unanswered") result.reason = record.reason
    return result
  }

  submit(requestId: string, text: string): Promise<Receipt> {
    if (!validRequestId(requestId) || !validText(text))
      return Promise.reject(new ActorError(400, "invalid_submission"))
    return this.#serial(async () => {
      const session = await this.#open(true)
      if (!session) throw new ActorError(503, "not_initialized")
      const { harness } = session
      // A status-only open can have no root (interrupted initialization).
      if (!session.root) {
        const configured = this.options.model()
        session.root = await harness.root(context, {
          agent: {
            model: configured.model,
            cwd: this.workspace,
            maxTurns: LIMITS.maxTurns,
            instructions:
              "Use read, write, edit, and bash in the workspace. Do not repeat an interrupted external effect. Report uncertain effects for operator recovery.",
          },
          init: async (tx, conversationId) => {
            ;(await tx.doc(IdentityDoc)).uid = session.identity.uid
            // Pi uuidv7 entropy can be cloned by a warm golden snapshot. Initialize only this new root.
            ;(await tx.doc(ProviderDoc, conversationId)).sessionId = actorScopedUuid(
              session.identity.uid,
              "provider/root",
            )
          },
        })
      }
      const root = session.root
      const existing = await harness.commit(
        (tx) => tx.submissionByRequest(root.id, requestId),
        context,
      )
      if (existing) {
        const prior = await harness.commit(async (tx) => {
          if (existing.entry) return (await tx.entry(existing.entry))?.model?.[0]
          const inbox = await tx.doc(InboxDoc, root.id)
          const item = inbox.items.find((item) => item.id === existing.id)
          return item && item.mode !== "write" ? { role: "user", content: item.content } : undefined
        }, context)
        if (prior?.role !== "user" || prior.content !== text)
          throw new ActorError(409, "request_payload_mismatch")
        // Use Pi's duplicate submission path, not a second application ledger.
        const retry = await root.submit(
          { type: "input", content: text, requestId, whenBusy: "reject" },
          context,
        )
        return this.#receipt(await retry.status(context))
      }
      if ((await harness.snapshot(RecoveryDoc, context))?.toolTaskId)
        throw new ActorError(409, "recovery_required")
      const inspection = await harness.inspect(context)
      if (inspection.tasks.length || inspection.submissions.length)
        throw new ActorError(409, "busy")
      try {
        const submission = await root.submit(
          { type: "input", content: text, requestId, whenBusy: "reject" },
          context,
        )
        return this.#receipt(await submission.status(context))
      } catch (error) {
        if (error instanceof ConversationBusy) throw new ActorError(409, "busy")
        throw error
      }
    })
  }

  status(requestId: string): Promise<Receipt> {
    if (!validRequestId(requestId)) return Promise.reject(new ActorError(400, "invalid_request_id"))
    return this.#serial(async () => {
      const session = await this.#open(false)
      if (!session?.root) throw new ActorError(404, "not_found")
      const root = session.root
      const record = await session.harness.commit(
        (tx) => tx.submissionByRequest(root.id, requestId),
        context,
      )
      if (!record) throw new ActorError(404, "not_found")
      return this.#receipt(record)
    })
  }

  quiescence() {
    return this.#serial(async () => {
      const session = await this.#open(false)
      if (!session)
        return { initialized: false, quiescent: true, active: false, recoveryRequired: false }
      const inspection = await session.harness.inspect(context)
      const wake = session.harness.wake()
      const recovery = await session.harness.snapshot(RecoveryDoc, context)
      const provider = session.root
        ? await session.harness.snapshot(ProviderDoc, session.root.id, context)
        : undefined
      return {
        actorUid: session.identity.uid,
        instanceId: session.instanceId,
        conversationId: session.root ? String(session.root.id) : undefined,
        providerSessionId: provider?.sessionId,
        initialized: Boolean(session.root),
        quiescent:
          !wake.active &&
          wake.at === undefined &&
          inspection.tasks.length === 0 &&
          inspection.submissions.length === 0,
        active: wake.active,
        wakeAt: wake.at,
        recoveryRequired: Boolean(recovery?.toolTaskId),
      }
    })
  }

  async close(): Promise<void> {
    this.#closed = true
    await this.#tail
    try {
      await this.session?.harness.close(context)
    } finally {
      await this.#unlock?.()
      this.#unlock = undefined
    }
  }
}
