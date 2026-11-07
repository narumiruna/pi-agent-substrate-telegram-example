import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { Pool } from "pg"
import { describe, expect, it, vi } from "vitest"
import { gatewayConfig, readTelegramToken } from "../src/gateway/config.js"
import { createGateway, type GatewayDependencies } from "../src/gateway/index.js"
import { TelegramClient } from "../src/gateway/telegram.js"
import type { SubstrateClient } from "../src/substrate/client.js"

const environment = {
  DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
  TELEGRAM_ALLOWED_USER_IDS: "7,8",
  SUBSTRATE_ATESPACE: "fixture",
  ACTOR_TEMPLATE: "pi-v1",
  ACTOR_IMAGE: `fixture.example/pi@sha256:${"a".repeat(64)}`,
  OPENAI_BASE_URL: "https://model.example/v1",
  OPENAI_MODEL: "gpt-4o-mini",
  OPENAI_MODEL_METADATA: "gpt-4o-mini",
  LLM_CREDENTIAL_URI: "ate-secret://k8s.io/provider/fixture/model/key",
  DEVELOPMENT_HOSTS: "",
  POD_NAMESPACE: "telegram-pi",
}
function dependencies(webhook = false) {
  const events: string[] = []
  const loss = new AbortController()
  const pool = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => ({ rows: [] })),
    end: vi.fn(async () => {}),
  }) as unknown as Pool
  const client = { close: vi.fn(async () => {}) } as unknown as SubstrateClient
  const telegram = new TelegramClient({
    token: "500:fixture_only",
    pollTimeoutSeconds: 0,
    requestTimeoutMs: 1000,
    fetch: async (url, init) => {
      const method = url.split("/").at(-1) ?? ""
      events.push(method)
      if (method === "getMe")
        return Response.json({
          ok: true,
          result: { id: 500, is_bot: true, username: "FixtureBot" },
        })
      if (method === "getWebhookInfo")
        return Response.json({
          ok: true,
          result: { url: webhook ? "https://operator.example/hook" : "" },
        })
      if (method === "getUpdates") {
        await new Promise<void>((_resolve, reject) => {
          const signal = init.signal
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          if (signal?.aborted) reject(new Error("aborted"))
        })
      }
      throw new Error("Unexpected Telegram method")
    },
  })
  const leader = {
    signal: loss.signal,
    acquire: vi.fn(async () => {
      events.push("leader")
    }),
    assert: vi.fn(async () => {
      loss.signal.throwIfAborted()
    }),
    invalidate: () => loss.abort(),
    close: vi.fn(async () => {
      loss.abort()
    }),
  }
  const deps: GatewayDependencies = {
    pool,
    client,
    telegram,
    capacity: vi.fn(async () => {
      events.push("capacity")
      return 2
    }),
    assertSchema: vi.fn(async () => {
      events.push("schema")
    }),
    ensureTemplate: vi.fn(async () => {
      events.push("template")
      return {}
    }) as unknown as GatewayDependencies["ensureTemplate"],
    leader: () => leader,
  }
  return { deps, leader, events }
}
async function health(server: { address: () => unknown }, path: string) {
  return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`)
}

describe("Gateway configuration and lifecycle", () => {
  it("validates production defaults and never accepts a third active dispatch", () => {
    expect(gatewayConfig(environment)).toMatchObject({
      tokenFile: "/var/run/telegram/token",
      caFile: "/var/run/ate/ca.crt",
      bundleFile: "/var/run/ate/credential-bundle.pem",
      maxActive: 2,
      poolName: "telegram-pi",
      egress: { developmentHosts: [] },
    })
    for (const bad of [
      { MAX_ACTIVE_DISPATCH: "3" },
      { MAX_ACTIVE_DISPATCH: "2\n" },
      { TELEGRAM_ALLOWED_USER_IDS: "@name" },
      { TELEGRAM_ALLOWED_USER_IDS: "7\n" },
      { POD_NAMESPACE: "" },
      { POD_NAMESPACE: "fixture\n" },
      { WORKER_POOL_NAME: "pool\n" },
      { ACTOR_TEMPLATE: "pi-v1\n" },
      { WORKER_POOL_LABEL: "pool\n" },
      { DATABASE_URL: "https://secret.example" },
      { OPENAI_BASE_URL: "https://user:secret@model.example" },
      { TELEGRAM_API_BASE_URL: "http://telegram.example" },
    ]) {
      expect(() => gatewayConfig({ ...environment, ...bad })).toThrow()
    }
  })

  it("rereads the projected token file per Telegram call and does not expose secret read errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-token-"))
    const path = join(dir, "token")
    const urls: string[] = []
    const client = new TelegramClient({
      token: () => readTelegramToken(path),
      fetch: async (url) => {
        urls.push(url)
        return Response.json({
          ok: true,
          result: { id: 500, is_bot: true, username: "FixtureBot" },
        })
      },
    })
    try {
      writeFileSync(path, "500:fixture_first")
      await client.getMe()
      writeFileSync(path, "500:fixture_second")
      await client.getMe()
      expect(urls[0]).not.toBe(urls[1])
      writeFileSync(path, "private-secret-value")
      await expect(client.getMe()).rejects.toThrow("token configuration")
      expect(() => readTelegramToken(path)).toThrow("Unable to read Telegram token configuration")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("serves health but not readiness until schema/template/Bot/webhook/leader/capacity are verified", async () => {
    const { deps, events } = dependencies()
    const gateway = await createGateway(gatewayConfig(environment), {
      healthPort: 0,
      dependencies: deps,
    })
    try {
      expect((await health(gateway.server, "/healthz")).status).toBe(200)
      expect((await health(gateway.server, "/readyz")).status).toBe(503)
      await gateway.start()
      expect((await health(gateway.server, "/readyz")).status).toBe(200)
      expect(events.slice(0, 6)).toEqual([
        "schema",
        "template",
        "getMe",
        "getWebhookInfo",
        "leader",
        "capacity",
      ])
      expect((await health(gateway.server, "/unknown")).status).toBe(404)
    } finally {
      await gateway.close()
    }
    expect(deps.client.close).toHaveBeenCalledOnce()
    expect(deps.pool.end).toHaveBeenCalledOnce()
  })

  it.each(["schema", "template", "webhook", "leader", "capacity"])(
    "never polls when %s startup verification fails",
    async (fault) => {
      const { deps, leader, events } = dependencies(fault === "webhook")
      const fail = async () => {
        throw new Error("fixture secret error must not escape")
      }
      if (fault === "schema") deps.assertSchema = fail
      if (fault === "template") deps.ensureTemplate = fail
      if (fault === "leader") leader.acquire = vi.fn(fail)
      if (fault === "capacity") deps.capacity = fail
      const gateway = await createGateway(gatewayConfig(environment), {
        healthPort: 0,
        dependencies: deps,
      })
      await expect(gateway.start()).rejects.toThrow("Gateway startup failed; admission is stopped")
      expect(gateway.ready).toBe(false)
      expect(events).not.toContain("getUpdates")
      await gateway.close()
    },
  )

  it.each(["signal", "leader", "pool"])(
    "stops new work and drains safely on %s loss",
    async (fault) => {
      const { deps, leader, events } = dependencies()
      const signal = new AbortController()
      const gateway = await createGateway(gatewayConfig(environment), {
        healthPort: 0,
        dependencies: deps,
      })
      await gateway.start(signal.signal)
      await sleep(20)
      if (fault === "signal") signal.abort()
      if (fault === "leader") leader.invalidate()
      if (fault === "pool") deps.pool.emit("error", new Error("database disconnected"))
      await gateway.stopped
      expect(gateway.ready).toBe(false)
      const count = events.length
      await sleep(10)
      expect(events).toHaveLength(count)
      expect(deps.pool.end).toHaveBeenCalledOnce()
    },
  )
})
