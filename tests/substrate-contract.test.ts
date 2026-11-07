import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  type ClientUnaryCall,
  credentials,
  Metadata,
  Server,
  ServerCredentials,
  type ServerUnaryCall,
  type ServiceError,
  status,
} from "@grpc/grpc-js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  Actor,
  ActorSandboxRuntime,
  ActorState,
  ActorTemplate,
  ControlClient,
  type ControlServer,
  ControlService,
  CreateActorRequest,
  CreateActorTemplateRequest,
  DeleteOptions,
  DurabilityMode,
  GetActorRequest,
  Resources,
  Snapshot,
  SnapshotFidelity,
  SnapshotOwner,
  SnapshotStorageState,
  SuspendActorRequest,
  SuspendActorResponse,
  WorkerServiceService,
} from "../src/substrate/generated/ateapi/v1/ateapi.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const protoPath = `${root}vendor/substrate/api/ateapi/v1/ateapi.proto`
const unsafeVersion = 9_007_199_254_740_993n
const actorRef = { atespace: "telegram-pi", name: "telegram-chat-123" }
const templateRef = { atespace: "telegram-pi", name: "pi-v1" }
const actorInput = Actor.create({
  metadata: actorRef,
  actorTemplate: templateRef,
  workerSelector: { matchLabels: { "ate.dev/sandbox-class": "gvisor" } },
  sourceTag: { atespace: "telegram-pi", name: "golden-pi-v1" },
})
const templateInput = ActorTemplate.create({
  metadata: templateRef,
  containers: [
    {
      name: "pi",
      image: `example.invalid/pi@sha256:${"a".repeat(64)}`,
      command: ["node"],
      args: ["/app/actor.js"],
      env: [{ name: "OPENAI_API_KEY", value: "contract-test-placeholder" }],
      volumeMounts: [{ name: "data", mountPath: "/data" }],
      wakeupProbe: { httpGet: { path: "/healthz", port: 8080 }, timeoutSeconds: 30 },
    },
  ],
  volumes: [{ name: "data", durableDir: {} }],
  resources: { limits: { cpuMillicores: 1_000n, memoryBytes: 536_870_912n } },
  snapshotConfig: { preferredFidelity: SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY },
})

function unary<T>(
  invoke: (callback: (error: ServiceError | null, response: T) => void) => ClientUnaryCall,
): Promise<T> {
  return new Promise((resolve, reject) => {
    invoke((error, response) => {
      if (error) reject(error)
      else resolve(response)
    })
  })
}

function deadline() {
  return { deadline: Date.now() + 3_000 }
}

// Use the pinned proto and protoc, not the generated TypeScript codec, as a wire oracle.
function encodeWithProtoc(message: string, text: string): Buffer {
  return execFileSync(
    `${root}node_modules/grpc-tools/bin/protoc${process.platform === "win32" ? ".exe" : ""}`,
    [
      "--proto_path=vendor/substrate/api",
      "--proto_path=vendor/substrate",
      `--encode=substrate.ateapi.v1.${message}`,
      "ateapi/v1/ateapi.proto",
    ],
    { cwd: root, input: text, timeout: 10_000 },
  )
}

function completedSnapshot(fidelity: SnapshotFidelity): Snapshot {
  return Snapshot.create({
    uuid: "snapshot-contract-2",
    generation: 2,
    owner: SnapshotOwner.SNAPSHOT_OWNER_ACTOR,
    fidelity,
    actorTemplateUid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    locality: "contract-worker-node",
    durableSnapshot: {
      state: SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
      object: {
        snapshotUri:
          "s3://contract-snapshots/atespaces/telegram-pi/actors/actor-uid/snapshot-contract-2",
      },
    },
    sandboxRuntime: ActorSandboxRuntime.create({
      sandboxClass: "gvisor",
      version: {
        schemaVersion: "v1",
        attributes: [
          { key: "architecture", value: "amd64" },
          { key: "sandbox_bundle_hash", value: "fixture-only" },
        ],
      },
    }),
  })
}

describe("pinned Substrate generated sources", () => {
  it("regenerates byte-for-byte from vendored inputs outside the repository cwd", () => {
    execFileSync("bash", [`${root}scripts/generate-substrate.sh`, "--check"], {
      cwd: tmpdir(),
      timeout: 30_000,
    })
  })

  it.each([
    ["Control", ControlService],
    ["WorkerService", WorkerServiceService],
  ] as const)("exposes every exact %s RPC path in the pinned proto", (serviceName, service) => {
    const source = readFileSync(protoPath, "utf8")
    const body = source.match(new RegExp(`^service ${serviceName} \\{([\\s\\S]*?)^\\}`, "m"))
    expect(body).not.toBeNull()
    const methods = [...(body?.[1] ?? "").matchAll(/^\s+rpc (\w+)\(/gm)].map((match) => match[1])
    expect(methods.length).toBeGreaterThan(0)
    expect(Object.values(service).map((method) => method.path)).toEqual(
      methods.map((method) => `/substrate.ateapi.v1.${serviceName}/${method}`),
    )
    for (const definition of Object.values(service)) {
      expect(definition.requestStream).toBe(false)
      expect(definition.responseStream).toBe(false)
    }
  })

  it("uses the pinned proto field tags for create, get, and synchronous suspend", () => {
    const create = CreateActorRequest.create({ actor: actorInput })
    const createWire = encodeWithProtoc(
      "CreateActorRequest",
      `actor {
        metadata { atespace: "telegram-pi" name: "telegram-chat-123" }
        actor_template { atespace: "telegram-pi" name: "pi-v1" }
        worker_selector { match_labels { key: "ate.dev/sandbox-class" value: "gvisor" } }
        source_tag { atespace: "telegram-pi" name: "golden-pi-v1" }
      }`,
    )
    expect(ControlService.createActor.requestSerialize(create)).toEqual(createWire)
    expect(ControlService.createActor.requestDeserialize(createWire)).toEqual(create)

    const get = GetActorRequest.create({ actor: actorRef })
    const getWire = encodeWithProtoc(
      "GetActorRequest",
      'actor { atespace: "telegram-pi" name: "telegram-chat-123" }',
    )
    expect(ControlService.getActor.requestSerialize(get)).toEqual(getWire)
    expect(ControlService.getActor.requestDeserialize(getWire)).toEqual(get)

    const suspend = SuspendActorRequest.create({
      actor: actorRef,
      options: { mode: DurabilityMode.DURABILITY_MODE_SYNCHRONOUS },
    })
    const suspendWire = encodeWithProtoc(
      "SuspendActorRequest",
      `actor { atespace: "telegram-pi" name: "telegram-chat-123" }
       options { mode: DURABILITY_MODE_SYNCHRONOUS }`,
    )
    expect(ControlService.suspendActor.requestSerialize(suspend)).toEqual(suspendWire)
    expect(ControlService.suspendActor.requestDeserialize(suspendWire)).toEqual(suspend)
  })

  it.each([0n, unsafeVersion, 9_223_372_036_854_775_807n, -9_223_372_036_854_775_808n])(
    "preserves int64 wire values without a Number conversion: %s",
    (value) => {
      // These are serialization limits, not claims about valid platform resource sizes.
      const resources = Resources.create({ cpuMillicores: value, memoryBytes: value })
      const wire = encodeWithProtoc("Resources", `cpu_millicores: ${value} memory_bytes: ${value}`)
      expect(Buffer.from(Resources.encode(resources).finish())).toEqual(wire)
      expect(Resources.decode(wire)).toEqual(resources)
      const guards = DeleteOptions.create({ version: value, uid: "fixture-uid" })
      expect(DeleteOptions.decode(DeleteOptions.encode(guards).finish())).toEqual(guards)
    },
  )

  it("decodes independent completed snapshot fields and nanosecond timestamps", () => {
    const wire = encodeWithProtoc(
      "SuspendActorResponse",
      `actor {
        metadata {
          atespace: "telegram-pi" name: "telegram-chat-123" version: ${unsafeVersion}
          update_time { seconds: 1800000000 nanos: 123456789 }
        }
        status {
          state: ACTOR_STATE_SUSPENDED
          snapshots {
            uuid: "snapshot-2" generation: 2 owner: SNAPSHOT_OWNER_ACTOR
            fidelity: SNAPSHOT_FIDELITY_MEMORY actor_template_uid: "template-uid"
            locality: "worker-node"
            durable_snapshot {
              state: SNAPSHOT_STORAGE_STATE_COMPLETED
              object { snapshot_uri: "s3://fixture/snapshot-2" }
            }
            sandbox_runtime {
              sandbox_class: "gvisor"
              version { schema_version: "v1" attributes { key: "architecture" value: "amd64" } }
            }
          }
          last_assigned_generation: 2
        }
      }`,
    )
    const response = SuspendActorResponse.create({
      actor: {
        metadata: {
          ...actorRef,
          version: unsafeVersion,
          updateTime: { seconds: 1_800_000_000n, nanos: 123_456_789 },
        },
        status: {
          state: ActorState.ACTOR_STATE_SUSPENDED,
          snapshots: [
            {
              uuid: "snapshot-2",
              generation: 2,
              owner: SnapshotOwner.SNAPSHOT_OWNER_ACTOR,
              fidelity: SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY,
              actorTemplateUid: "template-uid",
              locality: "worker-node",
              durableSnapshot: {
                state: SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
                object: { snapshotUri: "s3://fixture/snapshot-2" },
              },
              sandboxRuntime: {
                sandboxClass: "gvisor",
                version: {
                  schemaVersion: "v1",
                  attributes: [{ key: "architecture", value: "amd64" }],
                },
              },
            },
          ],
          lastAssignedGeneration: 2,
        },
      },
    })
    expect(ControlService.suspendActor.responseDeserialize(wire)).toEqual(response)
    expect(ControlService.suspendActor.responseSerialize(response)).toEqual(wire)
  })
})

// Loopback transport only. No platform auth, Router, or storage behavior is simulated as proof.
describe("Substrate generated client against a real in-process gRPC server", () => {
  let server: Server
  let client: ControlClient
  let actor: Actor | undefined
  let template: ActorTemplate | undefined
  let snapshot: Snapshot
  let observed: { path: string; request: unknown; authorization: (string | Buffer)[] }[]

  function observe<T, U>(call: ServerUnaryCall<T, U>) {
    observed.push({
      path: call.getPath(),
      request: call.request,
      authorization: call.metadata.get("authorization"),
    })
  }

  beforeEach(async () => {
    actor = undefined
    template = undefined
    observed = []
    snapshot = completedSnapshot(SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY)
    server = new Server()
    server.addService(ControlService, {
      createActor(call, callback) {
        observe(call)
        if (actor) {
          callback({ code: status.ALREADY_EXISTS, details: "contract actor already exists" })
          return
        }
        actor = Actor.create({
          ...call.request.actor,
          metadata: {
            ...call.request.actor?.metadata,
            uid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
            version: unsafeVersion,
            createTime: { seconds: 1_800_000_000n, nanos: 987_654_321 },
          },
          status: {
            state: ActorState.ACTOR_STATE_RUNNING,
            workerAssignment: { workerEpoch: unsafeVersion, workerPodIps: ["192.0.2.10"] },
          },
        })
        const headers = new Metadata()
        headers.set("x-contract-server", "in-process-fixture")
        call.sendMetadata(headers)
        callback(null, actor)
      },
      getActor(call, callback) {
        observe(call)
        callback(null, actor ?? Actor.create())
      },
      suspendActor(call, callback) {
        observe(call)
        actor = Actor.create({
          ...actor,
          status: {
            state: ActorState.ACTOR_STATE_SUSPENDED,
            snapshots: [snapshot],
            lastAssignedGeneration: snapshot.generation,
          },
        })
        const trailers = new Metadata()
        trailers.set("x-contract-snapshot", snapshot.uuid)
        callback(null, SuspendActorResponse.create({ actor }), trailers)
      },
      createActorTemplate(call, callback) {
        observe(call)
        template = call.request.actorTemplate
        callback(null, template)
      },
      getActorTemplate(call, callback) {
        observe(call)
        callback(null, template ?? ActorTemplate.create())
      },
    } satisfies Partial<ControlServer>)
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, boundPort) => {
        if (error) reject(error)
        else resolve(boundPort)
      })
    })
    client = new ControlClient(`127.0.0.1:${port}`, credentials.createInsecure())
  })

  afterEach(async () => {
    client?.close()
    await new Promise<void>((resolve, reject) => {
      server.tryShutdown((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  })

  it("transports create/get requests, bearer metadata, and response metadata", async () => {
    const metadata = new Metadata()
    metadata.set("authorization", "Bearer contract-fixture-not-a-real-token")
    let responseMetadata: Metadata | undefined
    const created = await unary<Actor>((callback) => {
      const call = client.createActor(
        CreateActorRequest.create({ actor: actorInput }),
        metadata,
        deadline(),
        callback,
      )
      call.on("metadata", (headers: Metadata) => {
        responseMetadata = headers
      })
      return call
    })
    const fetched = await unary<Actor>((callback) =>
      client.getActor(GetActorRequest.create({ actor: actorRef }), metadata, deadline(), callback),
    )
    expect(created).toEqual(actor)
    expect(fetched).toEqual(created)
    expect(created.metadata?.version).toBe(unsafeVersion)
    expect(created.status?.workerAssignment?.workerEpoch).toBe(unsafeVersion)
    expect(created.metadata?.createTime?.nanos).toBe(987_654_321)
    expect(responseMetadata?.get("x-contract-server")).toEqual(["in-process-fixture"])
    expect(observed).toEqual([
      {
        path: "/substrate.ateapi.v1.Control/CreateActor",
        request: CreateActorRequest.create({ actor: actorInput }),
        authorization: ["Bearer contract-fixture-not-a-real-token"],
      },
      {
        path: "/substrate.ateapi.v1.Control/GetActor",
        request: GetActorRequest.create({ actor: actorRef }),
        authorization: ["Bearer contract-fixture-not-a-real-token"],
      },
    ])
  })

  it("transports the full ActorTemplate specification and bigint resources", async () => {
    // This large memory value tests the transport, not platform resource admission.
    const request = CreateActorTemplateRequest.create({
      actorTemplate: {
        ...templateInput,
        resources: { limits: { cpuMillicores: 1_000n, memoryBytes: unsafeVersion } },
      },
    })
    const created = await unary<ActorTemplate>((callback) =>
      client.createActorTemplate(request, new Metadata(), deadline(), callback),
    )
    const fetched = await unary<ActorTemplate>((callback) =>
      client.getActorTemplate({ actorTemplate: templateRef }, new Metadata(), deadline(), callback),
    )
    expect(created).toEqual(request.actorTemplate)
    expect(fetched).toEqual(request.actorTemplate)
    expect(created.resources?.limits?.memoryBytes).toBe(unsafeVersion)
    expect(observed.map(({ path }) => path)).toEqual([
      "/substrate.ateapi.v1.Control/CreateActorTemplate",
      "/substrate.ateapi.v1.Control/GetActorTemplate",
    ])
    expect(observed[0]?.request).toEqual(request)
  })

  it.each([
    SnapshotFidelity.SNAPSHOT_FIDELITY_VOLUMES,
    SnapshotFidelity.SNAPSHOT_FIDELITY_ROOTFS,
    SnapshotFidelity.SNAPSHOT_FIDELITY_MEMORY,
  ])("transports synchronous suspend and COMPLETED snapshot fidelity %s", async (fidelity) => {
    snapshot = completedSnapshot(fidelity)
    await unary<Actor>((callback) =>
      client.createActor(
        CreateActorRequest.create({ actor: actorInput }),
        new Metadata(),
        deadline(),
        callback,
      ),
    )
    const request = SuspendActorRequest.create({
      actor: actorRef,
      options: { mode: DurabilityMode.DURABILITY_MODE_SYNCHRONOUS },
    })
    let trailers: Metadata | undefined
    const response = await unary<SuspendActorResponse>((callback) => {
      const call = client.suspendActor(request, new Metadata(), deadline(), callback)
      call.on("status", (result) => {
        trailers = result.metadata
      })
      return call
    })
    expect(observed[1]).toEqual({
      path: "/substrate.ateapi.v1.Control/SuspendActor",
      request,
      authorization: [],
    })
    expect(response.actor?.status?.state).toBe(ActorState.ACTOR_STATE_SUSPENDED)
    expect(response.actor?.status?.workerAssignment).toBeUndefined()
    expect(response.actor?.status?.snapshots).toEqual([snapshot])
    expect(response.actor?.metadata?.version).toBe(unsafeVersion)
    expect(trailers?.get("x-contract-snapshot")).toEqual([snapshot.uuid])
  })

  it("does not replace a returned PENDING snapshot with COMPLETED on synchronous suspend", async () => {
    // Upstream returns an already SUSPENDED Actor unchanged, even for SYNCHRONOUS.
    snapshot.durableSnapshot = {
      state: SnapshotStorageState.SNAPSHOT_STORAGE_STATE_PENDING,
      object: { snapshotUri: "s3://fixture/pending" },
    }
    actor = Actor.create({
      metadata: actorRef,
      status: { state: ActorState.ACTOR_STATE_SUSPENDED, snapshots: [snapshot] },
    })
    const response = await unary<SuspendActorResponse>((callback) =>
      client.suspendActor(
        SuspendActorRequest.create({
          actor: actorRef,
          options: { mode: DurabilityMode.DURABILITY_MODE_SYNCHRONOUS },
        }),
        new Metadata(),
        deadline(),
        callback,
      ),
    )
    expect(response.actor?.status?.snapshots).toEqual([snapshot])
    expect(response.actor?.status?.snapshots[0]?.durableSnapshot?.state).toBe(
      SnapshotStorageState.SNAPSHOT_STORAGE_STATE_PENDING,
    )
  })

  it("preserves ALREADY_EXISTS as gRPC status 6 and leaves the created record readable", async () => {
    const request = CreateActorRequest.create({ actor: actorInput })
    const created = await unary<Actor>((callback) =>
      client.createActor(request, new Metadata(), deadline(), callback),
    )
    await expect(
      unary<Actor>((callback) => client.createActor(request, new Metadata(), deadline(), callback)),
    ).rejects.toMatchObject({
      code: status.ALREADY_EXISTS,
      details: "contract actor already exists",
    })
    expect(status.ALREADY_EXISTS).toBe(6)
    const fetched = await unary<Actor>((callback) =>
      client.getActor(
        GetActorRequest.create({ actor: actorRef }),
        new Metadata(),
        deadline(),
        callback,
      ),
    )
    expect(fetched).toEqual(created)
  })
})
