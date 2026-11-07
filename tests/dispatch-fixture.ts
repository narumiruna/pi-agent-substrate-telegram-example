import { randomUUID } from "node:crypto"
import type { ActorResponse, SubstrateClient } from "../src/substrate/client.js"
import {
  Actor,
  ActorState,
  DurabilityMode,
  Snapshot,
  SnapshotFidelity,
  SnapshotOwner,
  SnapshotStorageState,
} from "../src/substrate/generated/ateapi/v1/ateapi.js"
import type { ensureActor } from "../src/substrate/provision.js"

export const atespace = "dispatch-fixture"
export const egress = {
  openAIBaseUrl: "https://model.example/v1",
  llmCredentialUri: "ate-secret://k8s.io/provider/fixture/model/key",
  developmentHosts: [],
}
export const response = (value: unknown, statusCode = 200): ActorResponse => ({
  statusCode,
  body: Buffer.from(JSON.stringify(value)),
  headers: {},
})
export function actorFixture() {
  const actors = new Map<string, Actor>()
  const receipts = new Map<
    string,
    {
      requestId: string
      submissionId: string
      conversationId: string
      status: string
      recoveryRequired: boolean
      answer?: string
    }
  >()
  const events: string[] = []
  let postLost = false
  let suspendLost = false
  let suspendNoop = false
  let interruptSuspend = false
  let pendingSnapshot = false
  let missingRequest = false
  let recoveryRequired = false
  let quietAfter = 0
  let pendingRuns = false
  let beforeHttp: (() => Promise<void>) | undefined
  let beforeSuspend: (() => Promise<void>) | undefined
  let httpOverride:
    | ((
        name: string,
        input: { method: "GET" | "POST"; path: string; body?: string },
      ) => Promise<ActorResponse>)
    | undefined
  const ensure: typeof ensureActor = async (_client, config) => {
    events.push("ensure")
    let actor = actors.get(config.name)
    if (!actor) {
      actor = Actor.create({
        metadata: { atespace, name: config.name, uid: randomUUID() },
        status: {
          state: ActorState.ACTOR_STATE_SUSPENDED,
          lastAssignedGeneration: 1,
          snapshots: [
            Snapshot.create({
              uuid: randomUUID(),
              generation: 1,
              owner: SnapshotOwner.SNAPSHOT_OWNER_ACTOR,
              fidelity: SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY,
              durableSnapshot: {
                state: SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
                object: { snapshotUri: "gs://fixture/old" },
              },
            }),
          ],
        },
      })
      actors.set(config.name, actor)
    }
    return structuredClone(actor)
  }
  const client = {
    rpc: async (
      method: string,
      input: { actor?: { name: string }; options?: { mode: number } },
    ) => {
      events.push(method)
      const actor = actors.get(input.actor?.name ?? "")
      if (!actor) throw Object.assign(new Error("not found"), { code: 5 })
      if (method === "getActor") return structuredClone(actor)
      if (method !== "suspendActor") throw new Error("Unexpected RPC")
      if (input.options?.mode !== DurabilityMode.DURABILITY_MODE_SYNCHRONOUS)
        throw new Error("Not synchronous")
      await beforeSuspend?.()
      if (!suspendNoop && actor.status && actor.status.state !== ActorState.ACTOR_STATE_SUSPENDED) {
        if (actor.status.state !== ActorState.ACTOR_STATE_SUSPENDING) {
          actor.status.state = ActorState.ACTOR_STATE_SUSPENDING
          const generation = ++actor.status.lastAssignedGeneration
          actor.status.snapshots.push(
            Snapshot.create({
              uuid: randomUUID(),
              generation,
              owner: SnapshotOwner.SNAPSHOT_OWNER_ACTOR,
              fidelity: SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY,
              durableSnapshot: {
                state: SnapshotStorageState.SNAPSHOT_STORAGE_STATE_PENDING,
                object: { snapshotUri: "gs://fixture/new" },
              },
            }),
          )
        }
        // Match the pinned API's persist-SUSPENDING-before-atelet-capture boundary.
        if (interruptSuspend) throw new Error("API interrupted before capture")
        actor.status.state = ActorState.ACTOR_STATE_SUSPENDED
        const snapshot = actor.status.snapshots.at(-1)
        if (snapshot?.durableSnapshot) {
          snapshot.durableSnapshot.state = pendingSnapshot
            ? SnapshotStorageState.SNAPSHOT_STORAGE_STATE_PENDING
            : SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED
          snapshot.durableSnapshot.object = {
            snapshotUri: pendingSnapshot ? "" : "gs://fixture/new",
          }
        }
      }
      if (suspendLost) throw new Error("lost suspend response")
      return { actor: structuredClone(actor) }
    },
    actor: async (
      target: { name: string },
      input: { method: "GET" | "POST"; path: string; body?: string },
    ) => {
      events.push(`${input.method} ${input.path.split("?")[0]}`)
      await beforeHttp?.()
      if (httpOverride) return httpOverride(target.name, input)
      const actor = actors.get(target.name)
      if (!actor?.status) throw new Error("Missing Actor")
      actor.status.state = ActorState.ACTOR_STATE_RUNNING
      if (input.method === "POST") {
        const body = JSON.parse(input.body ?? "") as { requestId: string }
        if (!missingRequest && !receipts.has(body.requestId))
          receipts.set(body.requestId, {
            requestId: body.requestId,
            submissionId: String(receipts.size + 1),
            conversationId: "1",
            status: pendingRuns ? "pending" : "done",
            recoveryRequired,
            answer: "fixture answer",
          })
        if (postLost) throw new Error("lost POST response")
        return response(receipts.get(body.requestId), 202)
      }
      if (input.path === "/v1/quiescence") {
        const quiet = quietAfter-- <= 0
        return response({
          actorUid: actor.metadata?.uid,
          recoveryRequired,
          quiescent: quiet,
          active: !quiet,
          ...(quiet ? {} : { wakeAt: Date.now() + 1000 }),
        })
      }
      const id = new URL(input.path, "http://actor").searchParams.get("requestId") ?? ""
      const found = receipts.get(id)
      return response(found ?? { error: "not_found" }, found ? 200 : 404)
    },
  } as unknown as Pick<SubstrateClient, "rpc" | "actor">
  return {
    actors,
    receipts,
    events,
    client,
    ensure,
    set postLost(value: boolean) {
      postLost = value
    },
    set suspendLost(value: boolean) {
      suspendLost = value
    },
    set suspendNoop(value: boolean) {
      suspendNoop = value
    },
    set pendingSnapshot(value: boolean) {
      pendingSnapshot = value
    },
    set interruptSuspend(value: boolean) {
      interruptSuspend = value
    },
    set missingRequest(value: boolean) {
      missingRequest = value
    },
    set recoveryRequired(value: boolean) {
      recoveryRequired = value
    },
    set quietAfter(value: number) {
      quietAfter = value
    },
    set pendingRuns(value: boolean) {
      pendingRuns = value
    },
    set beforeHttp(value: (() => Promise<void>) | undefined) {
      beforeHttp = value
    },
    set beforeSuspend(value: (() => Promise<void>) | undefined) {
      beforeSuspend = value
    },
    set httpOverride(value: typeof httpOverride) {
      httpOverride = value
    },
  }
}
