import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer, type Server as HttpsServer, request } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TLSSocket } from "node:tls"
import { Server, ServerCredentials, status } from "@grpc/grpc-js"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { SubstrateClient, type SubstrateOptions } from "../src/substrate/client.js"
import {
  Actor,
  type ControlServer,
  ControlService,
} from "../src/substrate/generated/ateapi/v1/ateapi.js"
import { tlsFixture } from "./identity/tls-fixture.js"

const target = { atespace: "test-space", name: "actor-1" }
const get = { actor: target }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Real TLS transports with synthetic authorization. Only the separate runtime
// suite can establish API policy, service-DNS CA, or Envoy SPIFFE enforcement.
describe("rotating Substrate TLS client (loopback contract only)", () => {
  let tls: ReturnType<typeof tlsFixture>
  let secondCa: ReturnType<typeof tlsFixture>
  let directory: string
  let version: number
  let api: Server
  let mtlsApi: Server
  let router: HttpsServer
  let address: string
  let mtlsAddress: string
  let origin: string
  let observed: string[]
  let effects: number
  let apiCalls: number
  let cancelledEffect: boolean
  let completedEffects: number
  let sockets: Set<TLSSocket>
  let clients: SubstrateClient[]

  function project(token = "allowed", ca = tls.ca, bundle = tls.gateway.bundle) {
    const revision = join(directory, `revision-${++version}`)
    mkdirSync(revision)
    writeFileSync(join(revision, "ca.crt"), ca)
    writeFileSync(join(revision, "bundle.pem"), bundle)
    writeFileSync(join(revision, "token"), token)
    symlinkSync(revision, join(directory, "next"))
    renameSync(join(directory, "next"), join(directory, "current"))
  }

  function config(kind: "bearer" | "mtls" = "bearer"): SubstrateOptions {
    return {
      caFile: join(directory, "current/ca.crt"),
      api: {
        address: kind === "bearer" ? address : mtlsAddress,
        auth:
          kind === "bearer"
            ? { kind, tokenFile: join(directory, "current/token") }
            : { kind, bundleFile: join(directory, "current/bundle.pem") },
      },
      router: { origin, bundleFile: join(directory, "current/bundle.pem") },
    }
  }

  function client(options = config()) {
    const value = new SubstrateClient(options)
    clients.push(value)
    return value
  }

  async function bind(
    server: Server,
    certificate: typeof tls,
    mtls: boolean,
    endpoint = "127.0.0.1:0",
  ) {
    return new Promise<string>((resolve, reject) =>
      server.bindAsync(
        endpoint,
        ServerCredentials.createSsl(
          certificate.ca,
          [
            {
              private_key: certificate.server.key,
              cert_chain: certificate.server.cert,
            },
          ],
          mtls,
        ),
        (error, port) => (error ? reject(error) : resolve(`127.0.0.1:${port}`)),
      ),
    )
  }

  beforeAll(() => {
    tls = tlsFixture()
    secondCa = tlsFixture()
  })

  afterAll(() => {
    rmSync(tls.directory, { recursive: true, force: true })
    rmSync(secondCa.directory, { recursive: true, force: true })
  })

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "substrate-projection-"))
    version = 0
    observed = []
    effects = 0
    apiCalls = 0
    cancelledEffect = false
    completedEffects = 0
    clients = []
    sockets = new Set()
    project()
    api = new Server()
    mtlsApi = new Server()
    function install(server: Server, mtls: boolean) {
      server.addService(ControlService, {
        getActor(call, callback) {
          apiCalls++
          const identity = mtls
            ? call.getAuthContext().sslPeerCertificate?.serialNumber
            : call.metadata.get("authorization")[0]
          observed.push(String(identity))
          if (!mtls && identity !== "Bearer allowed" && identity !== "Bearer renewed") {
            callback({ code: status.UNAUTHENTICATED, details: "synthetic invalid token" })
          } else if (call.request.actor?.name === "forbidden") {
            callback({ code: status.PERMISSION_DENIED, details: "synthetic insufficient grant" })
          } else {
            const delay = call.request.actor?.name === "slow" ? 150 : 0
            setTimeout(() => callback(null, Actor.create({ metadata: call.request.actor })), delay)
          }
        },
        createActor(call, callback) {
          apiCalls++
          effects++
          if (call.request.actor?.metadata?.name === "lost") {
            callback({ code: status.UNAVAILABLE, details: "synthetic response lost after effect" })
            return
          }
          setTimeout(() => {
            cancelledEffect = call.cancelled
            completedEffects++
            callback(null, Actor.create())
          }, 100)
        },
      } satisfies Partial<ControlServer>)
    }
    install(api, false)
    install(mtlsApi, true)
    address = await bind(api, tls, false)
    mtlsAddress = await bind(mtlsApi, tls, true)
    router = createServer(
      { ...tls.server, ca: tls.ca, requestCert: true, rejectUnauthorized: true },
      (req, res) => {
        const peer = (req.socket as TLSSocket).getPeerCertificate()
        observed.push(`${peer.serialNumber}:${req.headers["ate-target-actor"]}`)
        if (peer.subjectaltname !== "URI:spiffe://fixture/ns/app/sa/gateway") {
          res.writeHead(403).end("synthetic unlisted identity")
          return
        }
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "https://untrusted.invalid/" }).end()
          return
        }
        effects++
        if (req.url === "/large") res.end(Buffer.alloc(1_048_577))
        else if (req.url === "/slow") setTimeout(() => res.end("done"), 150)
        else res.end("ok")
      },
    )
    router.on("secureConnection", (socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve))
    const bound = router.address()
    if (!bound || typeof bound === "string") throw new Error("missing router address")
    origin = `https://localhost:${bound.port}`
  })

  afterEach(async () => {
    await Promise.all(clients.map((value) => value.close()))
    await Promise.all(
      [api, mtlsApi].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.tryShutdown((error) => (error ? reject(error) : resolve()))
          }),
      ),
    )
    await new Promise<void>((resolve, reject) =>
      router.close((error) => (error ? reject(error) : resolve())),
    )
    await expect.poll(() => sockets.size, { timeout: 1_000 }).toBe(0)
    rmSync(directory, { recursive: true, force: true })
  })

  it("uses TLS, sends the exact RPC/Actor target, and rereads bearer tokens without new processes", async () => {
    const value = client()
    expect((await value.rpc("getActor", get)).metadata?.name).toBe(target.name)
    project("renewed")
    await value.rpc("getActor", get)
    const response = await value.actor(target, { method: "POST", path: "/submit", body: "{}" })
    expect(response.statusCode).toBe(200)
    expect(response.body.toString()).toBe("ok")
    expect(observed.slice(0, 2)).toEqual(["Bearer allowed", "Bearer renewed"])
    expect(observed[2]).toContain(":test-space/actor-1")
  })

  it("rejects missing, wrong-audience fixture tokens and insufficient fixture grants", async () => {
    const value = client()
    project("")
    await expect(value.rpc("getActor", get)).rejects.toThrow("token is empty")
    expect(apiCalls).toBe(0)
    project("wrong-audience")
    await expect(value.rpc("getActor", get)).rejects.toMatchObject({ code: status.UNAUTHENTICATED })
    project("allowed")
    await expect(
      value.rpc("getActor", { actor: { ...target, name: "forbidden" } }),
    ).rejects.toMatchObject({ code: status.PERMISSION_DENIED })
  })

  it("does not present a Router certificate on bearer API calls", async () => {
    project("wrong-audience")
    await expect(client().rpc("getActor", get)).rejects.toMatchObject({
      code: status.UNAUTHENTICATED,
    })
    // Deliberate API mTLS is separate, and never sends the token metadata.
    await client(config("mtls")).rpc("getActor", get)
    expect(observed[1]).not.toContain("Bearer")
  })

  it("recycles mTLS channels and HTTPS agents after atomic leaf rotation, draining in-flight work", async () => {
    const value = client(config("mtls"))
    await value.rpc("getActor", get)
    await value.actor(target, { method: "GET", path: "/" })
    const first = [...observed]
    const runningRpc = value.rpc("getActor", { actor: { ...target, name: "slow" } })
    const runningHttp = value.actor(target, { method: "POST", path: "/slow", body: "{}" })
    await sleep(30)
    project("renewed", tls.ca, tls.renewed.bundle)
    await value.rpc("getActor", get)
    await value.actor(target, { method: "GET", path: "/" })
    expect(observed[4]).not.toBe(first[0])
    expect(observed[5]).not.toBe(first[1])
    expect((await runningHttp).body.toString()).toBe("done")
    await runningRpc
    expect(apiCalls).toBe(3)
    expect(effects).toBe(3)
  })

  it("reloads changed CA buffers and fails closed on untrusted servers", async () => {
    const value = client()
    await value.rpc("getActor", get)
    await value.actor(target, { method: "GET", path: "/" })
    project("allowed", secondCa.ca)
    await expect(value.rpc("getActor", get, { timeoutMs: 500 })).rejects.toMatchObject({
      code: status.UNAVAILABLE,
    })
    await expect(value.actor(target, { method: "GET", path: "/" })).rejects.toThrow()
    project("allowed", Buffer.concat([tls.ca, secondCa.ca]))
    await value.rpc("getActor", get)
    await value.actor(target, { method: "GET", path: "/" })
  })

  it("rejects missing/untrusted client certificates and synthetic unlisted SPIFFE identities before effects", async () => {
    const options = config()
    if (!options.router) throw new Error("missing fixture Router")
    options.router.bundleFile = join(directory, "absent.pem")
    await expect(client(options).actor(target, { method: "GET", path: "/" })).rejects.toThrow()
    project("allowed", tls.ca, secondCa.gateway.bundle)
    await expect(client().actor(target, { method: "GET", path: "/" })).rejects.toThrow()
    project("allowed", tls.ca, tls.unlisted.bundle)
    expect((await client().actor(target, { method: "GET", path: "/" })).statusCode).toBe(403)
    expect(effects).toBe(0)
  })

  it.each(["../bad", "bad/name", "UPPER", "a".repeat(64), "a\r\nx: y", "a\n", "-a", "a-", ""])(
    "rejects invalid target %j before network I/O",
    async (name) => {
      await expect(
        client().actor({ ...target, name }, { method: "GET", path: "/" }),
      ).rejects.toThrow("DNS labels")
      await expect(
        client().actor({ ...target, atespace: name }, { method: "GET", path: "/" }),
      ).rejects.toThrow("DNS labels")
      expect(effects).toBe(0)
    },
  )

  it.each(["https://evil.invalid/", "//evil.invalid/", "/\\evil.invalid/", "/x#fragment", "/\r\n"])(
    "refuses non-relative path %j",
    async (path) => {
      await expect(client().actor(target, { method: "GET", path })).rejects.toThrow(
        "origin-relative",
      )
      expect(effects).toBe(0)
    },
  )

  it("rejects unsafe configured origins and does not follow redirects", async () => {
    for (const origin of [
      "http://localhost",
      "https://user:pass@localhost",
      "https://localhost/path",
      "https://localhost/?x=y",
    ]) {
      expect(() => client({ ...config(), router: { origin, bundleFile: "unused" } })).toThrow(
        "trusted HTTPS origin",
      )
    }
    expect((await client().actor(target, { method: "GET", path: "/redirect" })).statusCode).toBe(
      302,
    )
    expect(effects).toBe(0)
  })

  it("bounds RPC/HTTP waits, does not retry effects, and bounds response bytes", async () => {
    const value = client()
    await value.rpc("getActor", get)
    apiCalls = 0
    await expect(
      value.rpc("createActor", { actor: Actor.create() }, { timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: status.DEADLINE_EXCEEDED })
    await expect(
      value.actor(target, { method: "POST", path: "/slow", body: "{}" }, { timeoutMs: 30 }),
    ).rejects.toThrow("deadline exceeded")
    await expect(value.actor(target, { method: "GET", path: "/large" })).rejects.toThrow(
      "exceeds 1 MiB",
    )
    await sleep(160)
    expect(apiCalls).toBe(1)
    expect(effects).toBe(3)
  })

  it("abort detaches only the wait; close drains bounded in-flight effects and prevents admission", async () => {
    const value = client()
    const controller = new AbortController()
    const rpc = value.rpc("createActor", { actor: Actor.create() }, { signal: controller.signal })
    const http = value.actor(
      target,
      { method: "POST", path: "/slow", body: "{}" },
      { signal: controller.signal },
    )
    await sleep(30)
    controller.abort(new Error("stop waiting"))
    await expect(rpc).rejects.toThrow("stop waiting")
    await expect(http).rejects.toThrow("stop waiting")
    let closed = false
    const closing = value.close().then(() => {
      closed = true
    })
    await sleep(20)
    expect(closed).toBe(false)
    await expect(value.rpc("getActor", get)).rejects.toThrow("closed")
    await closing
    await value.close()
    expect(apiCalls).toBe(1)
    expect(effects).toBe(2)
    expect(completedEffects).toBe(1)
    expect(cancelledEffect).toBe(false)
  })

  it("never replays an UNAVAILABLE RPC after a fixture effect", async () => {
    await expect(
      client().rpc("createActor", {
        actor: Actor.create({ metadata: { ...target, name: "lost" } }),
      }),
    ).rejects.toMatchObject({ code: status.UNAVAILABLE })
    await sleep(100)
    expect(apiCalls).toBe(1)
    expect(effects).toBe(1)
  })

  it("accepts a CA overlap, new root/leaf handshakes, and old-root retirement without client restart", async () => {
    const value = client()
    await value.rpc("getActor", get)
    await value.actor(target, { method: "GET", path: "/" })
    const overlap = Buffer.concat([tls.ca, secondCa.ca])
    project("allowed", overlap)
    await value.rpc("getActor", get)
    await value.actor(target, { method: "GET", path: "/" })
    // There are no active fixture calls. Replace the server's serving root/leaf.
    api.forceShutdown()
    api = new Server()
    api.addService(ControlService, {
      getActor(call, callback) {
        callback(null, Actor.create({ metadata: call.request.actor }))
      },
    } satisfies Partial<ControlServer>)
    await bind(api, secondCa, false, address)
    router.setSecureContext({ ...secondCa.server, ca: secondCa.ca })
    project("allowed", Buffer.concat([overlap, Buffer.from("\n")]), secondCa.gateway.bundle)
    await value.rpc("getActor", get)
    expect((await value.actor(target, { method: "GET", path: "/" })).statusCode).toBe(200)
    project("allowed", secondCa.ca, secondCa.gateway.bundle)
    await value.rpc("getActor", get)
    expect((await value.actor(target, { method: "GET", path: "/" })).statusCode).toBe(200)
  })

  it("verifies API and Router DNS names, not only their trusted CA", async () => {
    const options = config()
    options.api.serverName = "wrong.invalid"
    await expect(client(options).rpc("getActor", get)).rejects.toMatchObject({
      code: status.UNAVAILABLE,
    })
    const wrongRouter = config()
    if (!wrongRouter.router) throw new Error("missing fixture Router")
    wrongRouter.router.origin = origin.replace("localhost", "127.0.0.1")
    await expect(
      client(wrongRouter).actor(target, { method: "GET", path: "/" }),
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })
    expect(apiCalls).toBe(0)
    expect(effects).toBe(0)
  })

  it("a missing TLS client certificate is rejected by the local HTTPS server", async () => {
    await expect(
      new Promise((resolve, reject) => {
        const req = request(origin, { ca: tls.ca }, (res) => {
          res.resume()
          resolve(res.statusCode)
        })
        req.on("error", reject)
        const timer = setTimeout(() => req.destroy(new Error("fixture deadline")), 1_000)
        req.on("close", () => clearTimeout(timer))
        req.end()
      }),
    ).rejects.toThrow(/certificate required|handshake|socket hang up/i)
    expect(effects).toBe(0)
  })

  it("rejects invalid deadlines, pre-aborted waits, and an unconfigured provisioner Router before I/O", async () => {
    const value = client()
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, 300_001]) {
      await expect(value.rpc("getActor", get, { timeoutMs })).rejects.toThrow("timeoutMs")
      await expect(
        value.actor(target, { method: "GET", path: "/" }, { timeoutMs }),
      ).rejects.toThrow("timeoutMs")
    }
    const signal = AbortSignal.abort(new Error("already aborted"))
    await expect(value.rpc("getActor", get, { signal })).rejects.toThrow("already aborted")
    await expect(value.actor(target, { method: "GET", path: "/" }, { signal })).rejects.toThrow(
      "already aborted",
    )
    const options = config()
    delete options.router
    await expect(client(options).actor(target, { method: "GET", path: "/" })).rejects.toThrow(
      "not configured",
    )
    expect(apiCalls).toBe(0)
    expect(effects).toBe(0)
  })
})
