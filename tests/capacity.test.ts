import { once } from "node:events"
import { rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:https"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest"
import { CapacityUnavailable, createCapacityReader } from "../src/gateway/capacity.js"
import { tlsFixture } from "./identity/tls-fixture.js"

let tls: ReturnType<typeof tlsFixture>
let server: Server
let origin: string
let status: number
let reply: unknown
let observed: { path: string; authorization: string | undefined }[]
let caFile: string
let tokenFile: string
function pool(ready = 2) {
  return {
    apiVersion: "ate.dev/v1",
    kind: "WorkerPool",
    metadata: { namespace: "telegram-pi", name: "telegram-pi" },
    spec: { replicas: 2 },
    status: {
      replicas: 2,
      readyReplicas: ready,
      sandboxClasses: [{ name: "gvisor", conditions: [{ type: "Resolved", status: "True" }] }],
    },
  }
}
function reader() {
  return createCapacityReader({
    namespace: "telegram-pi",
    poolName: "telegram-pi",
    origin,
    caFile,
    tokenFile,
  })
}
beforeAll(() => {
  tls = tlsFixture()
  caFile = join(tls.directory, "capacity-ca.pem")
  tokenFile = join(tls.directory, "capacity-token")
})
beforeEach(async () => {
  writeFileSync(caFile, tls.ca)
  writeFileSync(tokenFile, "first-token\n")
  status = 200
  reply = pool()
  observed = []
  server = createServer(tls.server, (req, res) => {
    observed.push({ path: req.url ?? "", authorization: req.headers.authorization })
    res.writeHead(status, { "content-type": "application/json" })
    res.end(typeof reply === "string" ? reply : JSON.stringify(reply))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  origin = `https://localhost:${address.port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
afterAll(() => rmSync(tls.directory, { recursive: true, force: true }))

it("reads only its named pool and rereads rotated credentials", async () => {
  const read = reader()
  expect(await read()).toBe(2)
  writeFileSync(tokenFile, "renewed-token")
  writeFileSync(caFile, Buffer.concat([tls.ca, Buffer.from("\n")]))
  reply = pool(1)
  expect(await read()).toBe(1)
  expect(observed).toEqual([
    {
      path: "/apis/ate.dev/v1/namespaces/telegram-pi/workerpools/telegram-pi",
      authorization: "Bearer first-token",
    },
    {
      path: "/apis/ate.dev/v1/namespaces/telegram-pi/workerpools/telegram-pi",
      authorization: "Bearer renewed-token",
    },
  ])
})
it("does not report unresolved or absent workers as capacity", async () => {
  reply = pool(0)
  expect(await reader()()).toBe(0)
  const unresolved = pool()
  unresolved.status.sandboxClasses[0].conditions[0].status = "False"
  reply = unresolved
  expect(await reader()()).toBe(0)
  reply = { ...pool(), status: undefined }
  expect(await reader()()).toBe(0)
  reply = { ...pool(), spec: { replicas: 1 } }
  expect(await reader()()).toBe(1)
})
it.each([401, 403, 500])("fails closed on API status %s", async (code) => {
  status = code
  await expect(reader()()).rejects.toBeInstanceOf(CapacityUnavailable)
  expect(observed).toHaveLength(1)
})
it.each([
  "not JSON",
  "x".repeat(70_000),
  { ...pool(), metadata: { name: "other", namespace: "telegram-pi" } },
  { ...pool(), status: { replicas: 2, readyReplicas: -1 } },
  { ...pool(), spec: { replicas: "2" } },
])("rejects an invalid or oversized response", async (value) => {
  reply = value
  await expect(reader()()).rejects.toBeInstanceOf(CapacityUnavailable)
})
it("rejects missing credentials and pre-cancelled work before HTTP", async () => {
  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  await expect(reader()(controller.signal)).rejects.toThrow("cancelled")
  writeFileSync(tokenFile, "")
  await expect(reader()()).rejects.toBeInstanceOf(CapacityUnavailable)
  expect(observed).toEqual([])
})
it("verifies the API TLS certificate instead of accepting another root", async () => {
  writeFileSync(caFile, tls.gateway.cert)
  await expect(reader()()).rejects.toBeInstanceOf(CapacityUnavailable)
  expect(observed).toEqual([])
})
it.each(["../other", "Bad", "a\n", "a".repeat(64)])("rejects invalid pool names", (poolName) => {
  expect(() => createCapacityReader({ namespace: "telegram-pi", poolName })).toThrow("Invalid")
})
it.each(["http://localhost", "https://user:secret@localhost", "https://localhost/path"])(
  "rejects an untrusted API origin",
  (value) => {
    expect(() =>
      createCapacityReader({ namespace: "telegram-pi", poolName: "telegram-pi", origin: value }),
    ).toThrow("HTTPS")
  },
)
