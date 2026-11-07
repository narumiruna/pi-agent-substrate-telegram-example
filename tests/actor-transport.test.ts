import { once } from "node:events"
import { renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:https"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { rotatingProviderFetch } from "../src/actor/transport.js"
import { tlsFixture } from "./identity/tls-fixture.js"

const first = tlsFixture()
const second = tlsFixture()
afterAll(() => {
  rmSync(first.directory, { recursive: true, force: true })
  rmSync(second.directory, { recursive: true, force: true })
})

it("reloads an atomic trust projection in one process and retires old roots", async () => {
  const caFile = join(first.directory, "projected-ca.crt")
  function project(data: Buffer) {
    writeFileSync(`${caFile}.new`, data)
    renameSync(`${caFile}.new`, caFile)
  }
  const server = createServer(first.server, (_req, res) => res.end("verified"))
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing TLS address")
  const origin = `https://localhost:${address.port}`
  const request = rotatingProviderFetch(caFile)
  try {
    project(first.ca)
    expect(await (await request(origin)).text()).toBe("verified")
    // The warm process and fetch closure stay unchanged across the projection and leaf changes.
    project(Buffer.concat([first.ca, second.ca]))
    server.setSecureContext(second.server)
    expect(await (await request(origin)).text()).toBe("verified")
    project(second.ca)
    expect(await (await request(origin)).text()).toBe("verified")
    server.setSecureContext(first.server)
    await expect(request(origin)).rejects.toThrow()
    server.setSecureContext(second.server)
    expect(await (await request(origin)).text()).toBe("verified")
    await expect(request(`https://127.0.0.1:${address.port}`)).rejects.toThrow()
    project(Buffer.alloc(0))
    await expect(request(origin)).rejects.toThrow("trust bundle")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it("does not follow a provider redirect or retry a failed HTTP request", async () => {
  const caFile = join(first.directory, "redirect-ca.crt")
  writeFileSync(caFile, first.ca)
  let attempts = 0
  const server = createServer(first.server, (_req, res) => {
    attempts++
    res.writeHead(307, { location: "https://other.invalid/" })
    res.end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing TLS address")
  try {
    await expect(
      rotatingProviderFetch(caFile)(`https://localhost:${address.port}`),
    ).rejects.toThrow()
    expect(attempts).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
