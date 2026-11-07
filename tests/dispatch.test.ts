import { describe, expect, it } from "vitest"
import { GatewayDispatcher } from "../src/gateway/dispatch.js"
import type { GatewayStore } from "../src/gateway/store.js"
import { actorFixture, atespace, egress } from "./dispatch-fixture.js"

describe("dispatch bounds", () => {
  it("enforces the two-worker ceiling and bounded request/lease waits", () => {
    const fixture = actorFixture()
    const options = {
      store: {} as GatewayStore,
      client: fixture.client,
      atespace,
      botId: "500",
      template: "pi-v1",
      egress,
      capacity: async () => 2,
    }
    for (const bounds of [
      { maxActive: 3 },
      { maxActive: 0 },
      { leaseMs: 0 },
      { rpcTimeoutMs: 300001 },
      { pollIntervalMs: 0 },
    ]) {
      expect(() => new GatewayDispatcher({ ...options, ...bounds })).toThrow(
        "Invalid dispatch bounds",
      )
    }
    expect(new GatewayDispatcher(options).maxActive).toBe(2)
  })

  it("pre-aborted dispatch and scheduling have no database or Actor effect", async () => {
    const fixture = actorFixture()
    const d = new GatewayDispatcher({
      store: {} as GatewayStore,
      client: fixture.client,
      atespace,
      botId: "500",
      template: "pi-v1",
      egress,
      capacity: async () => {
        throw new Error("must not read capacity")
      },
    })
    const signal = new AbortController()
    signal.abort()
    expect(await d.dispatchConversation("telegram:500:100:main", signal.signal)).toBe("idle")
    expect(await d.dispatchOnce(signal.signal)).toBe(0)
    expect(fixture.events).toEqual([])
  })
})
