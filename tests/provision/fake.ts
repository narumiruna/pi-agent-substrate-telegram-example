import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Server, ServerCredentials, status } from "@grpc/grpc-js"
import { SubstrateClient } from "../../src/substrate/client.js"
import {
  Actor,
  ActorState,
  ActorTemplate,
  type ControlServer,
  ControlService,
  EgressPolicy,
  type ObjectRef,
  Snapshot,
  SnapshotFidelity,
  SnapshotOwner,
  SnapshotStorageState,
  Tag,
  TagScope,
} from "../../src/substrate/generated/ateapi/v1/ateapi.js"
import type { TemplateConfig } from "../../src/substrate/provision.js"
import type { tlsFixture } from "../identity/tls-fixture.js"

export const templateConfig: TemplateConfig = {
  atespace: "telegram-pi",
  name: "pi-v1",
  image: `localhost:25071/telegram-pi-actor@sha256:${"a".repeat(64)}`,
  openAIBaseUrl: "https://llm.example.test:8443/openai/v1",
  openAIModel: "test-deployment",
  openAIModelMetadata: "gpt-4.1-mini",
}
export const egressConfig = {
  openAIBaseUrl: templateConfig.openAIBaseUrl,
  llmCredentialUri: "ate-secret://k8s.io/default/llm-secrets/openai/api-key",
  developmentHosts: ["github.com", "registry.npmjs.org"],
}
export const waitOptions = { timeoutMs: 2000, pollIntervalMs: 2 }
const key = (ref: ObjectRef | undefined) => `${ref?.atespace}/${ref?.name}`

/** An in-process gRPC record store. It does not establish any platform runtime gate. */
export async function fakeControl(tls: ReturnType<typeof tlsFixture>) {
  const templates = new Map<string, ActorTemplate>()
  const actors = new Map<string, Actor>()
  const policies = new Map<string, EgressPolicy>()
  const tags = new Map<string, Tag>()
  const calls: string[] = []
  const lost = new Set<"template" | "actor" | "policy">()
  const beforeCommit = new Set<"template" | "actor" | "policy">()
  const state = {
    goldenReady: true,
    goldenError: "",
    pendingTag: false,
    unavailableGets: 0,
    denyPolicy: false,
    hangTemplateGet: false,
    reads: 0,
    onTemplateGet: undefined as (() => void) | undefined,
    onPolicyCreate: undefined as (() => void) | undefined,
  }
  const server = new Server()
  server.addService(ControlService, {
    createActorTemplate(call, callback) {
      calls.push("createActorTemplate")
      const record = ActorTemplate.create(call.request.actorTemplate)
      const id = key(record.metadata)
      if (templates.has(id)) return callback({ code: status.ALREADY_EXISTS, details: "exists" })
      if (beforeCommit.delete("template"))
        return callback({ code: status.UNAVAILABLE, details: "before commit" })
      const templateUid = randomUUID()
      record.metadata = {
        ...(record.metadata as NonNullable<typeof record.metadata>),
        uid: templateUid,
        version: 2n,
      }
      const goldenRef = { atespace: record.metadata.atespace, name: templateUid }
      record.status = {
        goldenSnapshotStatus: {
          goldenTag: state.goldenReady ? goldenRef : undefined,
          errorMessage: state.goldenError,
          snapshotTime: undefined,
        },
      }
      templates.set(id, record)
      tags.set(
        key(goldenRef),
        Tag.create({
          metadata: { ...goldenRef, uid: randomUUID(), version: 1n },
          scope: TagScope.TAG_SCOPE_PUBLISHED,
          sourceActor: goldenRef,
          status: {
            actorTemplateUid: templateUid,
            snapshot: Snapshot.create({
              uuid: randomUUID(),
              generation: 1,
              owner: SnapshotOwner.SNAPSHOT_OWNER_TAG,
              fidelity: SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY,
              actorTemplateUid: templateUid,
              durableSnapshot: {
                state: state.pendingTag
                  ? SnapshotStorageState.SNAPSHOT_STORAGE_STATE_PENDING
                  : SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
                object: {
                  snapshotUri: `gs://ate-snapshots/atespaces/${record.metadata.atespace}/tags/${templateUid}`,
                },
              },
            }),
          },
        }),
      )
      if (lost.delete("template"))
        return callback({ code: status.UNAVAILABLE, details: "lost create response" })
      callback(null, record)
    },
    getActorTemplate(call, callback) {
      calls.push("getActorTemplate")
      state.reads++
      state.onTemplateGet?.()
      if (state.hangTemplateGet) return
      if (state.unavailableGets-- > 0)
        return callback({ code: status.UNAVAILABLE, details: "transient read" })
      const record = templates.get(key(call.request.actorTemplate))
      if (!record) return callback({ code: status.NOT_FOUND, details: "missing template" })
      callback(null, record)
    },
    getTag(call, callback) {
      calls.push("getTag")
      const record = tags.get(key(call.request.tag))
      if (!record) return callback({ code: status.NOT_FOUND, details: "missing tag" })
      callback(null, record)
    },
    createActor(call, callback) {
      calls.push("createActor")
      const record = Actor.create(call.request.actor)
      const id = key(record.metadata)
      if (actors.has(id)) return callback({ code: status.ALREADY_EXISTS, details: "exists" })
      if (beforeCommit.delete("actor"))
        return callback({ code: status.UNAVAILABLE, details: "before commit" })
      record.metadata = {
        ...(record.metadata as NonNullable<typeof record.metadata>),
        uid: randomUUID(),
        version: 1n,
      }
      record.status = Actor.create({ status: { state: ActorState.ACTOR_STATE_SUSPENDED } }).status
      actors.set(id, record)
      if (lost.delete("actor"))
        return callback({ code: status.DEADLINE_EXCEEDED, details: "lost create response" })
      callback(null, record)
    },
    getActor(call, callback) {
      calls.push("getActor")
      const record = actors.get(key(call.request.actor))
      if (!record) return callback({ code: status.NOT_FOUND, details: "missing actor" })
      callback(null, record)
    },
    createActorEgressPolicy(call, callback) {
      calls.push("createActorEgressPolicy")
      state.onPolicyCreate?.()
      if (state.denyPolicy)
        return callback({ code: status.PERMISSION_DENIED, details: "policy denied" })
      const id = key(call.request.actor)
      if (!actors.has(id)) return callback({ code: status.NOT_FOUND, details: "missing parent" })
      if (policies.has(id)) return callback({ code: status.ALREADY_EXISTS, details: "exists" })
      if (beforeCommit.delete("policy"))
        return callback({ code: status.UNAVAILABLE, details: "before commit" })
      const record = EgressPolicy.create(call.request.egressPolicy)
      record.metadata = {
        ...(record.metadata as NonNullable<typeof record.metadata>),
        uid: randomUUID(),
        version: 1n,
      }
      policies.set(id, record)
      if (lost.delete("policy"))
        return callback({ code: status.UNAVAILABLE, details: "lost create response" })
      callback(null, record)
    },
    getActorEgressPolicy(call, callback) {
      calls.push("getActorEgressPolicy")
      const record = policies.get(key(call.request.actor))
      if (!record) return callback({ code: status.NOT_FOUND, details: "missing policy" })
      callback(null, record)
    },
  } satisfies Partial<ControlServer>)
  const address = await new Promise<string>((resolve, reject) => {
    server.bindAsync(
      "127.0.0.1:0",
      ServerCredentials.createSsl(
        tls.ca,
        [{ private_key: tls.server.key, cert_chain: tls.server.cert }],
        true,
      ),
      (error, port) => (error ? reject(error) : resolve(`127.0.0.1:${port}`)),
    )
  })
  const bundleFile = join(tls.directory, "provisioner.pem")
  writeFileSync(bundleFile, tls.unlisted.bundle)
  const client = new SubstrateClient({
    caFile: join(tls.directory, "ca.crt"),
    api: { address, auth: { kind: "mtls", bundleFile } },
  })
  return {
    client,
    templates,
    actors,
    policies,
    tags,
    calls,
    state,
    lost,
    beforeCommit,
    template: () => templates.values().next().value as ActorTemplate,
    tag: () => tags.values().next().value as Tag,
    actor: () => actors.values().next().value as Actor,
    policy: () => policies.values().next().value as EgressPolicy,
    close: async () => {
      await client.close()
      server.forceShutdown()
    },
  }
}
