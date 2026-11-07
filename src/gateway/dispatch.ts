import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import type { ActorResponse, SubstrateClient } from "../substrate/client.js"
import {
  type Actor,
  ActorState,
  DurabilityMode,
  type Snapshot,
  SnapshotOwner,
  SnapshotStorageState,
} from "../substrate/generated/ateapi/v1/ateapi.js"
import { type EgressConfig, ensureActor, ProvisionConflict } from "../substrate/provision.js"
import { splitTelegramText } from "./delivery.js"
import type { ClaimedJob, GatewayStore, Job, Ownership } from "./store.js"

export type DispatchStore = Pick<
  GatewayStore,
  | "getConversation"
  | "getJob"
  | "getOwnership"
  | "claimNext"
  | "renew"
  | "bindActor"
  | "recordAdmissionBaseline"
  | "markSubmissionAttempted"
  | "recordSubmission"
  | "saveResult"
  | "recordSuspendIntent"
  | "observeSuspendSnapshot"
  | "confirmCheckpoint"
  | "requireRecovery"
  | "resumeReconciled"
  | "listDispatchWork"
  | "listMappedActors"
>
export type DispatchClient = Pick<SubstrateClient, "rpc" | "actor">
export interface DispatchOptions {
  store: DispatchStore
  client: DispatchClient
  botId: string
  atespace: string
  template: string
  egress: EgressConfig
  /** Ready workers in this application's WorkerPool, not global workers. */
  capacity: (signal?: AbortSignal) => Promise<number>
  maxActive?: number
  leaseMs?: number
  pollIntervalMs?: number
  reconciliationMs?: number
  checkpointWaitMs?: number
  rpcTimeoutMs?: number
  ensureActor?: typeof ensureActor
  /** Safe diagnostic code only. No upstream exception or token-bearing URL. */
  onError?: (code: string) => void
}
export type DispatchOutcome = "idle" | "completed" | "recovery_needed" | "interrupted"

class Recovery extends Error {}
class OwnershipLost extends Error {}
function sameOwner(claim: ClaimedJob | null, owner: Ownership, margin = 0): claim is ClaimedJob {
  return (
    claim?.ownership.token === owner.token &&
    claim.ownership.fence === owner.fence &&
    claim.ownership.requestId === owner.requestId &&
    (claim.conversation.leaseUntil?.getTime() ?? 0) > Date.now() + margin
  )
}

/** A lease remains live during bounded network waits. Unknown renewal is read, never assumed. */
class Lease {
  readonly stop = new AbortController()
  readonly signal: AbortSignal
  readonly interval: number
  private readonly renewing: Promise<void>
  constructor(
    readonly store: DispatchStore,
    readonly owner: Ownership,
    readonly ms: number,
    signal?: AbortSignal,
  ) {
    this.signal = signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal
    this.interval = Math.max(1, Math.floor(ms / 3))
    this.renewing = this.loop().catch(() => this.stop.abort(new OwnershipLost()))
  }
  async check() {
    this.signal.throwIfAborted()
    try {
      await this.store.renew(this.owner, this.ms)
    } catch {
      const claim = await this.store.getOwnership(this.owner.conversationKey)
      if (!sameOwner(claim, this.owner, this.interval)) throw new OwnershipLost()
    }
    this.signal.throwIfAborted()
  }
  private async loop() {
    while (!this.signal.aborted) {
      await sleep(this.interval, undefined, { signal: this.signal })
      await this.check()
    }
  }
  async close() {
    this.stop.abort()
    await this.renewing
  }
}
interface Receipt {
  requestId: string
  submissionId: string
  conversationId: string
  status: "pending" | "done" | "unanswered" | "recovery_required"
  recoveryRequired: boolean
  answer?: string
}
function json(response: ActorResponse): Record<string, unknown> {
  try {
    const body: unknown = JSON.parse(response.body.toString("utf8"))
    if (body && typeof body === "object" && !Array.isArray(body))
      return body as Record<string, unknown>
  } catch {}
  throw new Recovery("invalid_actor_response")
}
function receipt(response: ActorResponse, job: Job): Receipt | null {
  if (response.statusCode === 404) return null
  const body = json(response)
  if (body.error === "recovery_required") throw new Recovery("actor_recovery_required")
  if (response.statusCode !== 200 && response.statusCode !== 202) return null
  if (
    body.requestId !== job.requestId ||
    typeof body.submissionId !== "string" ||
    !body.submissionId ||
    typeof body.conversationId !== "string" ||
    !body.conversationId ||
    !["pending", "done", "unanswered", "recovery_required"].includes(String(body.status)) ||
    typeof body.recoveryRequired !== "boolean" ||
    (body.answer !== undefined && typeof body.answer !== "string")
  )
    throw new Recovery("invalid_actor_receipt")
  if (job.submissionId !== null && body.submissionId !== job.submissionId)
    throw new Recovery("submission_identity_changed")
  if (body.recoveryRequired || body.status === "recovery_required")
    throw new Recovery("actor_recovery_required")
  return body as unknown as Receipt
}
function generation(actor: Actor): string {
  const value = actor.status?.lastAssignedGeneration
  if (value === undefined || !Number.isSafeInteger(value) || value < 0)
    throw new Recovery("unknown_actor_generation")
  return String(value)
}
function running(actor: Actor) {
  return (
    actor.status?.state === ActorState.ACTOR_STATE_RUNNING ||
    actor.status?.state === ActorState.ACTOR_STATE_RESUMING
  )
}

function intendedSnapshot(actor: Actor, job: Job): Snapshot {
  const snapshots =
    actor.status?.snapshots.filter(
      (snapshot) => String(snapshot.generation) === job.suspendGeneration,
    ) ?? []
  const snapshot = snapshots[0]
  if (
    snapshots.length !== 1 ||
    !snapshot?.uuid ||
    snapshot.owner !== SnapshotOwner.SNAPSHOT_OWNER_ACTOR ||
    (job.suspendSnapshotId !== null && job.suspendSnapshotId !== snapshot.uuid)
  )
    throw new Recovery("checkpoint_snapshot_changed")
  return snapshot
}

/** PostgreSQL is the durable dispatch journal. Only the API's idempotent suspend workflow can reenter. */
export class GatewayDispatcher {
  readonly options: DispatchOptions
  private readonly busy = new Map<string, Promise<DispatchOutcome>>()
  private scheduling = false
  readonly maxActive: number
  readonly leaseMs: number
  readonly pollMs: number
  readonly reconcileMs: number
  readonly checkpointMs: number
  readonly rpcMs: number
  constructor(options: DispatchOptions) {
    this.options = options
    this.maxActive = options.maxActive ?? 2
    this.leaseMs = options.leaseMs ?? 60_000
    this.pollMs = options.pollIntervalMs ?? 1000
    this.reconcileMs = options.reconciliationMs ?? 30_000
    this.checkpointMs = options.checkpointWaitMs ?? 180_000
    this.rpcMs = options.rpcTimeoutMs ?? 30_000
    if (
      !Number.isInteger(this.maxActive) ||
      this.maxActive < 1 ||
      this.maxActive > 2 ||
      !Number.isInteger(this.leaseMs) ||
      this.leaseMs < 30 ||
      this.leaseMs > 3_600_000 ||
      [this.pollMs, this.reconcileMs, this.checkpointMs, this.rpcMs].some(
        (n) => !Number.isInteger(n) || n < 1,
      ) ||
      this.rpcMs > 300_000
    )
      throw new Error("Invalid dispatch bounds")
  }

  dispatchConversation(key: string, signal?: AbortSignal): Promise<DispatchOutcome> {
    if (signal?.aborted || this.busy.has(key) || this.busy.size >= this.maxActive)
      return Promise.resolve("idle")
    const pending = this.run(key, signal)
      .catch(() => {
        this.options.onError?.("dispatch_wait_stopped")
        return "interrupted" as const
      })
      .finally(() => this.busy.delete(key))
    this.busy.set(key, pending)
    return pending
  }

  /** Start old active jobs before queued work. Capacity failure blocks new admission, not reattachment. */
  async dispatchOnce(signal?: AbortSignal): Promise<number> {
    if (this.scheduling || signal?.aborted) return 0
    this.scheduling = true
    try {
      const { store, botId } = this.options
      const candidates = await store.listDispatchWork(botId, 1000)
      let available = 0
      let capacityKnown = false
      let ceiling = 0
      let occupied = new Set<string>()
      try {
        const occupancy = await this.occupancy(signal)
        occupied = occupancy.occupied
        ceiling = occupancy.ceiling
        // Local jobs without a worker yet reserve one. Do not double-count running mapped jobs.
        const reserved = [...this.busy.keys()].filter((key) => !occupied.has(key)).length
        available = Math.max(0, ceiling - occupied.size - reserved)
        capacityKnown = true
      } catch {
        this.options.onError?.("capacity_unavailable")
      }
      let started = 0
      for (const candidate of candidates) {
        if (signal?.aborted || this.busy.size >= this.maxActive) break
        const key = candidate.conversation.key
        if (this.busy.has(key)) continue
        const reattachment =
          candidate.job.submissionAttempted ||
          candidate.job.finalOutcome !== null ||
          candidate.job.suspendGeneration !== null
        if (
          !reattachment &&
          (!capacityKnown || (occupied.has(key) ? occupied.size > ceiling : available < 1))
        )
          continue
        if (!reattachment && !occupied.has(key)) available--
        // Always attach a rejection handler before starting the next iteration.
        void this.dispatchConversation(key, signal)
        started++
      }
      return started
    } finally {
      this.scheduling = false
    }
  }
  async drain() {
    await Promise.all([...this.busy.values()])
  }

  private async occupancy(signal?: AbortSignal) {
    const { store, client, botId, atespace } = this.options
    const ready = await this.options.capacity(signal)
    if (!Number.isSafeInteger(ready) || ready < 0) throw new Error("Unknown capacity")
    const occupied = new Set<string>()
    for (const conversation of await store.listMappedActors(botId)) {
      let actor: Actor
      try {
        actor = await client.rpc(
          "getActor",
          { actor: { atespace, name: conversation.actorName } },
          { timeoutMs: this.rpcMs, signal },
        )
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === 5)
          continue
        throw error
      }
      if (actor.metadata?.uid !== conversation.actorUid || !actor.status)
        throw new Error("Unknown Actor occupancy")
      if (
        actor.status.state !== ActorState.ACTOR_STATE_SUSPENDED &&
        actor.status.state !== ActorState.ACTOR_STATE_CRASHED
      )
        occupied.add(conversation.key)
    }
    return { occupied, ceiling: Math.min(this.maxActive, ready) }
  }
  private async checkAdmissionCapacity(lease: Lease) {
    const { occupied, ceiling } = await this.occupancy(lease.signal)
    const reserved = [...this.busy.keys()].filter((key) => !occupied.has(key)).length
    if (occupied.size + reserved > ceiling) throw new OwnershipLost()
    await lease.check()
  }

  private async run(key: string, signal?: AbortSignal): Promise<DispatchOutcome> {
    const { store, botId } = this.options
    if ((await store.getConversation(key))?.botId !== botId || signal?.aborted) return "idle"
    const token = randomUUID()
    let claim: ClaimedJob | null
    try {
      claim = await store.claimNext(key, { token, leaseMs: this.leaseMs })
    } catch {
      claim = await store.getOwnership(key)
      if (claim?.ownership.token !== token || !sameOwner(claim, claim.ownership))
        return "interrupted"
    }
    if (!claim) return "idle"
    const lease = new Lease(store, claim.ownership, this.leaseMs, signal)
    try {
      await this.process(claim, lease)
      return "completed"
    } catch (error) {
      if (error instanceof Recovery && !lease.signal.aborted) {
        await this.mutate(
          lease,
          () => store.requireRecovery(claim.ownership, error.message),
          (job) => job.state === "recovery_needed" && job.reason === error.message,
        )
        return "recovery_needed"
      }
      // Shutdown/ownership loss stops only waits. Leave durable active work for a later owner.
      if (!lease.signal.aborted) this.options.onError?.("dispatch_wait_stopped")
      return "interrupted"
    } finally {
      await lease.close()
    }
  }

  private async job(owner: Ownership): Promise<Job> {
    const job = await this.options.store.getJob(owner.requestId)
    if (!job) throw new OwnershipLost()
    return job
  }
  private async mutate(
    lease: Lease,
    mutate: () => Promise<void>,
    confirmed: (job: Job) => boolean,
  ): Promise<Job> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await lease.check()
      try {
        await mutate()
        return await this.job(lease.owner)
      } catch {
        const job = await this.job(lease.owner)
        if (confirmed(job)) return job
        await lease.check()
      }
    }
    throw new OwnershipLost()
  }
  private async getActor(name: string, uid: string, lease: Lease): Promise<Actor> {
    await lease.check()
    let actor: Actor
    try {
      actor = await this.options.client.rpc(
        "getActor",
        { actor: { atespace: this.options.atespace, name } },
        { timeoutMs: this.rpcMs, signal: lease.signal },
      )
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 5)
        throw new Recovery("actor_missing")
      throw error
    }
    if (
      actor.metadata?.uid !== uid ||
      actor.metadata.name !== name ||
      actor.metadata.atespace !== this.options.atespace ||
      actor.metadata.deleteTime
    )
      throw new Recovery("actor_identity_changed")
    if (
      [
        ActorState.ACTOR_STATE_CRASHED,
        ActorState.ACTOR_STATE_DELETING,
        ActorState.ACTOR_STATE_REVERTING,
      ].includes(actor.status?.state ?? 0)
    )
      throw new Recovery("actor_state_lost")
    generation(actor)
    return actor
  }
  private async actorHttp(
    name: string,
    method: "POST" | "GET",
    path: string,
    lease: Lease,
    body?: string,
  ) {
    await lease.check()
    return this.options.client.actor(
      { atespace: this.options.atespace, name },
      { method, path, ...(body === undefined ? {} : { body }) },
      { timeoutMs: this.rpcMs, signal: lease.signal },
    )
  }

  private async process(claim: ClaimedJob, lease: Lease) {
    const { store } = this.options
    const owner = claim.ownership
    const name = claim.conversation.actorName
    let uid = claim.conversation.actorUid
    let actor: Actor
    // This API read MUST precede any Router status call on recovery. Router GET can resume state.
    if (uid) {
      actor = await this.getActor(name, uid, lease)
      if (!claim.job.submissionAttempted) await this.checkAdmissionCapacity(lease)
    } else {
      if (claim.job.submissionAttempted) throw new Recovery("unbound_attempted_actor")
      await this.checkAdmissionCapacity(lease)
      try {
        actor = await (this.options.ensureActor ?? ensureActor)(
          this.options.client,
          {
            atespace: this.options.atespace,
            name,
            template: { atespace: this.options.atespace, name: this.options.template },
            egress: this.options.egress,
          },
          { signal: lease.signal },
        )
      } catch (error) {
        if (error instanceof ProvisionConflict) throw new Recovery("actor_provision_conflict")
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === 7 || error.code === 16)
        )
          throw new Recovery("actor_provision_denied")
        throw error
      }
      uid = actor.metadata?.uid ?? null
      if (!uid) throw new Recovery("actor_identity_missing")
      const actorUid = uid
      await lease.check()
      try {
        await store.bindActor(owner, actorUid)
      } catch {
        if ((await store.getConversation(owner.conversationKey))?.actorUid !== actorUid)
          throw new OwnershipLost()
      }
    }
    let job = await this.job(owner)
    if (job.submissionAttempted && job.admissionGeneration === null)
      throw new Recovery("unknown_admission_baseline")
    if (job.state === "recovery_needed") {
      if (job.reason !== "owner_lost" && job.reason !== "checkpoint_pending")
        throw new Recovery(job.reason ?? "manual_recovery")
      const phase = job.recoveryFrom
      if (!phase) throw new Recovery("unknown_recovery_phase")
      job = await this.mutate(
        lease,
        () => store.resumeReconciled(owner, phase),
        (stored) => stored.state === phase,
      )
    }
    if (job.state === "result_awaiting_checkpoint") {
      await this.checkpoint(name, uid, actor, job, lease)
      return
    }
    if (job.state !== "running") throw new Recovery("invalid_dispatch_phase")
    if (!job.submissionAttempted) {
      const baseline = generation(actor)
      job = await this.mutate(
        lease,
        () => store.recordAdmissionBaseline(owner, baseline),
        (stored) => stored.admissionGeneration === baseline,
      )
      job = await this.mutate(
        lease,
        () => store.markSubmissionAttempted(owner),
        (stored) => stored.submissionAttempted,
      )
      // One network POST only. Lost responses always reconcile through GET of this request ID.
      try {
        await this.actorHttp(
          name,
          "POST",
          "/v1/submissions",
          lease,
          JSON.stringify({ requestId: job.requestId, text: job.text }),
        )
      } catch {
        lease.signal.throwIfAborted()
      }
    } else if (!running(actor) || generation(actor) !== job.admissionGeneration) {
      throw new Recovery("attempted_actor_state_changed")
    }
    const missingUntil = Date.now() + this.reconcileMs
    let result: Receipt
    for (;;) {
      lease.signal.throwIfAborted()
      // Check control state before Router access, also after a long pending run.
      actor = await this.getActor(name, uid, lease)
      if (!running(actor) || generation(actor) !== job.admissionGeneration)
        throw new Recovery("attempted_actor_state_changed")
      let found: Receipt | null = null
      try {
        found = receipt(
          await this.actorHttp(
            name,
            "GET",
            `/v1/submissions?requestId=${encodeURIComponent(job.requestId)}`,
            lease,
          ),
          job,
        )
      } catch (error) {
        if (error instanceof Recovery) throw error
        lease.signal.throwIfAborted()
      }
      if (!found) {
        if (Date.now() >= missingUntil) throw new Recovery("attempted_request_missing")
      } else {
        const id = found.submissionId
        job = await this.mutate(
          lease,
          () => store.recordSubmission(owner, id),
          (stored) => stored.submissionId === id,
        )
        if (found.status !== "pending") {
          result = found
          break
        }
      }
      await sleep(this.pollMs, undefined, { signal: lease.signal })
    }
    const chunks = result.status === "done" ? splitTelegramText(result.answer ?? "") : []
    job = await this.mutate(
      lease,
      () =>
        store.saveResult(owner, {
          submissionId: result.submissionId,
          outcome: result.status === "done" ? "succeeded" : "failed",
          chunks,
        }),
      (stored) =>
        stored.state === "result_awaiting_checkpoint" &&
        stored.submissionId === result.submissionId,
    )
    await this.checkpoint(name, uid, actor, job, lease)
  }

  private async checkpoint(name: string, uid: string, actor: Actor, job: Job, lease: Lease) {
    const { store } = this.options
    const owner = lease.owner
    actor = await this.getActor(name, uid, lease)
    if (job.suspendGeneration === null) {
      if (!running(actor) || generation(actor) !== job.admissionGeneration)
        throw new Recovery("checkpoint_without_intent")
      // Do not suspend background compaction, sleeping retry work, or any active Harness task.
      for (;;) {
        const q = json(await this.actorHttp(name, "GET", "/v1/quiescence", lease))
        if (q.recoveryRequired !== false) throw new Recovery("actor_recovery_required")
        if (q.actorUid !== uid) throw new Recovery("actor_identity_changed")
        if (q.quiescent === true && q.active === false && q.wakeAt === undefined) break
        await sleep(this.pollMs, undefined, { signal: lease.signal })
      }
      actor = await this.getActor(name, uid, lease)
      if (!running(actor) || generation(actor) !== job.admissionGeneration)
        throw new Recovery("checkpoint_actor_changed")
      const intended = String(BigInt(generation(actor)) + 1n)
      job = await this.mutate(
        lease,
        () => store.recordSuspendIntent(owner, intended),
        (stored) => stored.suspendGeneration === intended,
      )
    }
    // An intent proves prior quiescence. A crash before the RPC is safe to reconcile through
    // the API's idempotent suspend workflow, but never through a Router request.
    actor = await this.getActor(name, uid, lease)
    const suspendedInProgress =
      actor.status?.state === ActorState.ACTOR_STATE_SUSPENDING &&
      generation(actor) === job.suspendGeneration
    if (suspendedInProgress) {
      const snapshot = intendedSnapshot(actor, job)
      job = await this.mutate(
        lease,
        () =>
          store.observeSuspendSnapshot(owner, {
            generation: String(snapshot.generation),
            snapshotId: snapshot.uuid,
          }),
        (stored) => stored.suspendSnapshotId === snapshot.uuid,
      )
    }
    if (
      suspendedInProgress ||
      (actor.status?.state === ActorState.ACTOR_STATE_RUNNING &&
        generation(actor) === job.admissionGeneration &&
        job.admissionGeneration !== null &&
        BigInt(job.suspendGeneration as string) === BigInt(job.admissionGeneration) + 1n)
    ) {
      await lease.check()
      try {
        await this.options.client.rpc(
          "suspendActor",
          {
            actor: { atespace: this.options.atespace, name },
            options: { mode: DurabilityMode.DURABILITY_MODE_SYNCHRONOUS },
          },
          { timeoutMs: Math.min(300_000, this.checkpointMs), signal: lease.signal },
        )
      } catch {
        lease.signal.throwIfAborted()
      }
    }
    // Reconcile the receipt with API reads only. A Router GET here could undo the checkpoint.
    const until = Date.now() + this.checkpointMs
    for (;;) {
      actor = await this.getActor(name, uid, lease)
      const currentGeneration = BigInt(generation(actor))
      const intended = BigInt(job.suspendGeneration as string)
      if (currentGeneration > intended) throw new Recovery("checkpoint_generation_changed")
      if (currentGeneration === intended) {
        const snapshot = intendedSnapshot(actor, job)
        job = await this.mutate(
          lease,
          () =>
            store.observeSuspendSnapshot(owner, {
              generation: String(snapshot.generation),
              snapshotId: snapshot.uuid,
            }),
          (stored) => stored.suspendSnapshotId === snapshot.uuid,
        )
        if (
          actor.status?.state === ActorState.ACTOR_STATE_SUSPENDED &&
          snapshot.durableSnapshot?.state ===
            SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED &&
          snapshot.durableSnapshot.object?.snapshotUri.trim()
        ) {
          const remoteUri = snapshot.durableSnapshot.object.snapshotUri
          await this.mutate(
            lease,
            () =>
              store.confirmCheckpoint(owner, {
                actorName: name,
                actorUid: uid,
                snapshotId: snapshot.uuid,
                generation: String(snapshot.generation),
                remoteUri,
              }),
            (stored) =>
              stored.state === "completed" &&
              stored.checkpoint?.snapshotId === snapshot.uuid &&
              stored.checkpoint.generation === String(snapshot.generation),
          )
          return
        }
      }
      if (Date.now() >= until) throw new Recovery("checkpoint_pending")
      await sleep(this.pollMs, undefined, { signal: lease.signal })
    }
  }
}
