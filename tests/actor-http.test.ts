import { once } from "node:events"
import { stat } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import { expect, it } from "vitest"
import { LIMITS } from "../src/actor/config.js"
import { actorServer } from "../src/actor/http.js"
import type { ActorRuntime } from "../src/actor/runtime.js"
import { eventually, fixture, requestId, settled } from "./actor/helpers.js"

async function serve(runtime: ActorRuntime) {
  const server = actorServer(runtime)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

it("keeps golden probes free of writable state and refreshes metadata at first admission", async () => {
  let uid = "golden"
  let identityReads = 0
  const f = await fixture([fauxAssistantMessage("actual actor")], {
    identity: async () => {
      identityReads++
      return { uid, name: uid, atespace: "test" }
    },
  })
  const http = await serve(f.runtime)
  try {
    for (const path of ["/healthz", "/warmup", "/wakeup"])
      expect((await fetch(http.url + path)).status).toBe(200)
    expect(identityReads).toBe(0)
    expect(f.runtime.session).toBeUndefined()
    await expect(stat(f.runtime.database)).rejects.toMatchObject({ code: "ENOENT" })
    uid = "actual-a"
    expect((await fetch(`${http.url}/v1/submissions?requestId=${requestId}`)).status).toBe(404)
    expect(await (await fetch(`${http.url}/v1/quiescence`)).json()).toMatchObject({
      initialized: false,
      quiescent: true,
    })
    await expect(stat(f.runtime.database)).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      (
        await fetch(`${http.url}/v1/submissions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId, text: "hello" }),
        })
      ).status,
    ).toBe(202)
    expect((await settled(f.runtime)).answer).toBe("actual actor")
    expect(f.runtime.session?.identity.uid).toBe("actual-a")
    uid = "actual-b"
    expect(await (await fetch(`${http.url}/v1/quiescence`)).json()).toEqual({
      error: "identity_changed",
    })
  } finally {
    await http.close()
    await f.cleanup()
  }
})

it("bounds HTTP input and failure responses without admitting invalid work", async () => {
  const f = await fixture()
  const http = await serve(f.runtime)
  const post = (body: string, contentType = "application/json") =>
    fetch(`${http.url}/v1/submissions`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
  try {
    expect(http.server.requestTimeout).toBe(LIMITS.httpTimeoutMs)
    expect((await post("hello", "text/plain")).status).toBe(415)
    expect((await post("{")).status).toBe(400)
    for (const value of [
      null,
      [],
      {},
      { requestId, text: "" },
      { requestId: "bad", text: "x" },
      { requestId, text: "x", extra: "bad" },
      { requestId, text: "x".repeat(LIMITS.textBytes + 1) },
    ]) {
      expect((await post(JSON.stringify(value))).status).toBe(400)
    }
    expect((await post("x".repeat(LIMITS.requestBytes + 1))).status).toBe(413)
    expect((await fetch(`${http.url}/v1/submissions`)).status).toBe(400)
    expect((await fetch(`${http.url}/unknown`)).status).toBe(404)
    expect(f.runtime.session).toBeUndefined()
    expect(f.faux.state.callCount).toBe(0)
    await expect(stat(f.runtime.database)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await http.close()
    await f.cleanup()
  }
  const broken = await fixture([], {
    identity: async () => {
      throw new Error("private-error-secret")
    },
  })
  const failed = await serve(broken.runtime)
  try {
    const response = await fetch(`${failed.url}/v1/quiescence`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "actor_unavailable" })
  } finally {
    await failed.close()
    await broken.cleanup()
  }
})

it("keeps durable admission alive when the HTTP client cancels", async () => {
  let release: (() => void) | undefined
  let read = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture([fauxAssistantMessage("still completed")], {
    identity: async () => {
      read = true
      await gate
      return { uid: "actor-a", name: "chat-a", atespace: "test" }
    },
  })
  const http = await serve(f.runtime)
  try {
    const controller = new AbortController()
    const request = fetch(`${http.url}/v1/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, text: "hello" }),
      signal: controller.signal,
    }).catch(() => undefined)
    await eventually(async () => read, Boolean)
    controller.abort()
    await request
    release?.()
    expect((await settled(f.runtime)).answer).toBe("still completed")
    expect(
      (await fetch(`${http.url}/v1/submissions?requestId=${encodeURIComponent(requestId)}`)).status,
    ).toBe(200)
    expect(f.faux.state.callCount).toBe(1)
  } finally {
    release?.()
    await http.close()
    await f.cleanup()
  }
})

it("bounds an oversized status response", async () => {
  const f = await fixture()
  f.runtime.status = async () => ({
    requestId,
    submissionId: "1",
    conversationId: "1",
    status: "done",
    piStatus: "done",
    recoveryRequired: false,
    answer: "x".repeat(LIMITS.responseBytes),
  })
  const http = await serve(f.runtime)
  try {
    const response = await fetch(`${http.url}/v1/submissions?requestId=${requestId}`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "response_too_large" })
    expect(f.faux.state.callCount).toBe(0)
  } finally {
    await http.close()
    await f.cleanup()
  }
})

it("bounds queued HTTP operations while initialization is blocked", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture([], {
    identity: async () => {
      await gate
      return { uid: "a", name: "a", atespace: "test" }
    },
  })
  try {
    const waits = Array.from({ length: LIMITS.admissionQueue }, () => f.runtime.quiescence())
    await expect(f.runtime.quiescence()).rejects.toMatchObject({ status: 503, code: "overloaded" })
    release?.()
    await Promise.all(waits)
  } finally {
    release?.()
    await f.cleanup()
  }
})
