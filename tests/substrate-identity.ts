// Required local runtime suite, not an automatic *.test.ts unit test.
// Run only after main confirms task 3 smoke AND HTTPS fixture readiness.
import assert from "node:assert/strict"
import { createHash, X509Certificate } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { Agent, request } from "node:https"
import { join } from "node:path"
import { credentials, Metadata, status } from "@grpc/grpc-js"
import { SubstrateClient, type SubstrateOptions } from "../src/substrate/client.js"
import {
  type Actor,
  ActorState,
  ActorTemplate,
  ControlClient,
  DurabilityMode,
  SnapshotStorageState,
} from "../src/substrate/generated/ateapi/v1/ateapi.js"

const base = "/tmp/identity-runtime"
const projected = "/var/run/ate"
const actorRef = { atespace: "telegram-pi-platform-smoke", name: "counter-smoke" }
const routerOrigin = "https://atenet-router.ate-system.svc"
const clients: SubstrateClient[] = []
const evidence: { check: string; result: string; details?: unknown }[] = []
let revision = 0

function record(check: string, details?: unknown) {
  evidence.push({ check, result: "PASS", details })
  console.log(JSON.stringify(evidence.at(-1)))
}

function project(token: Buffer, bundle: Buffer, ca = readFileSync(join(projected, "ca.crt"))) {
  const directory = join(base, `revision-${++revision}`)
  mkdirSync(directory)
  writeFileSync(join(directory, "token"), token, { mode: 0o600 })
  writeFileSync(join(directory, "bundle.pem"), bundle, { mode: 0o600 })
  writeFileSync(join(directory, "ca.crt"), ca)
  symlinkSync(directory, join(base, "next"))
  renameSync(join(base, "next"), join(base, "current"))
}

function client(auth: SubstrateOptions["api"]["auth"], router = false) {
  const value = new SubstrateClient({
    caFile: join(base, "current/ca.crt"),
    api: { auth },
    ...(router
      ? { router: { origin: routerOrigin, bundleFile: join(base, "current/bundle.pem") } }
      : {}),
  })
  clients.push(value)
  return value
}

function certificate(bundle: Buffer) {
  const pem = bundle
    .toString()
    .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)
  assert(pem, "missing projected leaf certificate")
  return new X509Certificate(pem[0])
}

function hash(value: Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

async function denied(check: string, pending: Promise<unknown>, code: number) {
  await assert.rejects(
    pending,
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === code,
  )
  record(check, { grpcCode: code })
}

function snapshot(actor: Actor) {
  const current = actor.status?.snapshots.find(
    (item) => item.generation === actor.status?.lastAssignedGeneration,
  )
  assert.equal(actor.status?.state, ActorState.ACTOR_STATE_SUSPENDED)
  assert(current, "latest snapshot is absent")
  assert.equal(
    current.durableSnapshot?.state,
    SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED,
  )
  assert(current.durableSnapshot?.object?.snapshotUri)
  return {
    actorUid: actor.metadata?.uid,
    generation: current.generation,
    snapshotUuid: current.uuid,
    uri: current.durableSnapshot.object.snapshotUri,
  }
}

async function checkpoint(gateway: SubstrateClient) {
  await gateway.rpc(
    "suspendActor",
    {
      actor: actorRef,
      options: { mode: DurabilityMode.DURABILITY_MODE_SYNCHRONOUS },
    },
    { timeoutMs: 180_000 },
  )
  const until = Date.now() + 120_000
  while (true) {
    const actor = await gateway.rpc("getActor", { actor: actorRef })
    const current = actor.status?.snapshots.find(
      (item) => item.generation === actor.status?.lastAssignedGeneration,
    )
    if (
      actor.status?.state === ActorState.ACTOR_STATE_SUSPENDED &&
      current?.durableSnapshot?.state === SnapshotStorageState.SNAPSHOT_STORAGE_STATE_COMPLETED
    )
      return snapshot(actor)
    assert(Date.now() < until, "latest checkpoint did not complete")
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function missingApiCredential() {
  const raw = new ControlClient(
    "dns:///api.ate-system.svc:443",
    credentials.createSsl(readFileSync(join(projected, "ca.crt"))),
    {
      "grpc.enable_retries": 0,
    },
  )
  try {
    await denied(
      "API missing credential",
      new Promise((resolve, reject) => {
        raw.getActor(
          { actor: actorRef },
          new Metadata(),
          { deadline: Date.now() + 10_000 },
          (error, value) => (error ? reject(error) : resolve(value)),
        )
      }),
      status.UNAUTHENTICATED,
    )
  } finally {
    raw.close()
  }
}

async function missingRouterCredential() {
  const agent = new Agent({ ca: readFileSync(join(projected, "ca.crt")) })
  try {
    await assert.rejects(
      new Promise((resolve, reject) => {
        const req = request(
          routerOrigin,
          {
            agent,
            path: "/readyz",
            headers: {
              "ate-target-actor": `${actorRef.atespace}/${actorRef.name}`,
            },
          },
          (res) => {
            res.resume()
            // Envoy currently rejects this at TLS. Do not accept a generic upstream error.
            reject(new Error(`Expected a TLS denial, got HTTP ${res.statusCode}`))
          },
        )
        const timer = setTimeout(
          () => req.destroy(new Error("missing credential request timed out")),
          10_000,
        )
        req.on("error", (error) => {
          clearTimeout(timer)
          if (
            /certificate required|handshake failure|ECONNRESET|socket hang up/i.test(error.message)
          )
            reject(error)
          else resolve(error)
        })
        req.on("close", () => clearTimeout(timer))
        req.end()
      }),
      /certificate required|handshake failure|ECONNRESET|socket hang up/i,
    )
    record("Router missing certificate rejected at TLS")
  } finally {
    agent.destroy()
  }
}

async function run() {
  assert.equal(process.argv[2], "--task3-ready", "main must confirm task3 before runtime execution")
  const token = readFileSync(join(projected, "api-token"))
  const bundle = readFileSync(join(projected, "credential-bundle.pem"))
  const renewedToken = readFileSync(join(base, "renewed-token"))
  const renewedBundle = readFileSync(join(base, "renewed-bundle"))
  const wrongAudience = readFileSync(join(projected, "wrong-audience"))
  assert.notEqual(hash(token), hash(renewedToken), "rotation tokens must differ")
  assert.notEqual(certificate(bundle).fingerprint256, certificate(renewedBundle).fingerprint256)
  assert.equal(
    certificate(bundle).subjectAltName,
    "URI:spiffe://cluster.local/ns/telegram-pi/sa/gateway",
  )
  assert.equal(certificate(renewedBundle).subjectAltName, certificate(bundle).subjectAltName)
  project(token, bundle)
  const bearer = client({ kind: "bearer", tokenFile: join(base, "current/token") }, true)
  const mtls = client({ kind: "mtls", bundleFile: join(base, "current/bundle.pem") }, true)
  const provisioner = client({ kind: "mtls", bundleFile: join(base, "provisioner-bundle") })
  const ungranted = client({ kind: "bearer", tokenFile: join(base, "ungranted-token") })
  const unlisted = new SubstrateClient({
    caFile: join(projected, "ca.crt"),
    api: { auth: { kind: "mtls", bundleFile: join(base, "ungranted-bundle") } },
    router: { origin: routerOrigin, bundleFile: join(base, "provisioner-bundle") },
  })
  clients.push(unlisted)

  const actor = await bearer.rpc("getActor", { actor: actorRef })
  assert(actor.metadata?.uid)
  assert(actor.actorTemplate)
  await mtls.rpc("getActor", { actor: actorRef })
  record("Gateway allowed API bearer and deliberate mTLS", { actorUid: actor.metadata.uid })
  // Verify the explicit default policy exists before any Router call.
  await bearer.rpc("getActorEgressPolicy", { actor: actorRef, name: "default" })
  const template = await provisioner.rpc("getActorTemplate", { actorTemplate: actor.actorTemplate })
  const input = ActorTemplate.create({
    ...template,
    metadata: { atespace: actor.actorTemplate.atespace, name: actor.actorTemplate.name },
    status: undefined,
  })
  await denied(
    "Provisioner editor reaches template create handler (existing immutable record)",
    provisioner.rpc("createActorTemplate", { actorTemplate: input }),
    status.ALREADY_EXISTS,
  )
  record("Provisioner distinct API principal, no configured Router path", {
    identity: certificate(readFileSync(join(base, "provisioner-bundle"))).subjectAltName,
  })
  await denied(
    "Gateway is not global viewer/owner",
    bearer.rpc("listWorkers", { options: undefined }),
    status.PERMISSION_DENIED,
  )
  await denied(
    "Provisioner is not global viewer/owner",
    provisioner.rpc("listWorkers", { options: undefined }),
    status.PERMISSION_DENIED,
  )

  const before = await checkpoint(bearer)
  record("Actor checkpoint before denied ingress", before)
  const unchanged = async (check: string) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    assert.deepEqual(snapshot(await bearer.rpc("getActor", { actor: actorRef })), before)
    record(check, before)
  }
  await missingApiCredential()
  project(wrongAudience, bundle)
  await denied(
    "API wrong audience on token-only channel",
    bearer.rpc("getActor", { actor: actorRef }),
    status.UNAUTHENTICATED,
  )
  project(token, bundle)
  await denied(
    "API insufficient bearer grants",
    ungranted.rpc("getActor", { actor: actorRef }),
    status.PERMISSION_DENIED,
  )
  await denied(
    "API insufficient mTLS grants",
    unlisted.rpc("getActor", { actor: actorRef }),
    status.PERMISSION_DENIED,
  )
  await denied(
    "API denied ResumeActor",
    ungranted.rpc("resumeActor", { actor: actorRef }),
    status.PERMISSION_DENIED,
  )
  await unchanged("Denied API did not resume Actor")
  await missingRouterCredential()
  await unchanged("Missing Router certificate did not resume Actor")
  await assert.rejects(
    unlisted.actor(actorRef, { method: "GET", path: "/readyz" }, { timeoutMs: 10_000 }),
    /certificate|handshake|ECONNRESET|socket hang up/i,
  )
  record("Router rejected genuine but unlisted provisioner SPIFFE certificate")
  await unchanged("Unlisted Router identity did not resume Actor")

  const response = await bearer.actor(
    actorRef,
    { method: "GET", path: "/readyz" },
    { timeoutMs: 120_000 },
  )
  assert.equal(response.statusCode, 200, response.body.toString())
  assert.equal(
    (await bearer.rpc("getActor", { actor: actorRef })).status?.state,
    ActorState.ACTOR_STATE_RUNNING,
  )
  record("Allowed Gateway Router mTLS resumed Actor", { statusCode: response.statusCode })
  await mtls.actor(actorRef, { method: "GET", path: "/readyz" })
  project(renewedToken, renewedBundle)
  await bearer.rpc("getActor", { actor: actorRef })
  await mtls.rpc("getActor", { actor: actorRef })
  assert.equal((await bearer.actor(actorRef, { method: "GET", path: "/readyz" })).statusCode, 200)
  assert.equal((await mtls.actor(actorRef, { method: "GET", path: "/readyz" })).statusCode, 200)
  record("Atomic token and genuine leaf replacement without process/client restart", {
    pid: process.pid,
    firstLeaf: certificate(bundle).fingerprint256,
    secondLeaf: certificate(renewedBundle).fingerprint256,
    firstTokenHash: hash(token),
    secondTokenHash: hash(renewedToken),
  })
  // Alter the projected CA buffer, retaining the real service-DNS roots. No CA
  // pool or server trust is changed. New real connections must still verify TLS.
  const ca = readFileSync(join(projected, "ca.crt"))
  project(renewedToken, renewedBundle, Buffer.concat([ca, Buffer.from("\n")]))
  await mtls.rpc("getActor", { actor: actorRef })
  assert.equal((await mtls.actor(actorRef, { method: "GET", path: "/readyz" })).statusCode, 200)
  record("CA-buffer refresh reconnects to real API and Router (not signer/root rotation)")
  record("Final completed checkpoint", await checkpoint(bearer))
}

try {
  await run()
  console.log(JSON.stringify({ result: "PASS", checks: evidence.length }))
} catch (error) {
  console.error(JSON.stringify({ result: "FAIL", error: String(error), checks: evidence.length }))
  process.exitCode = 1
} finally {
  await Promise.all(clients.map((value) => value.close()))
}
