import { createServer, type Server } from "node:http"
import { resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { Pool } from "pg"
import { SubstrateClient } from "../substrate/client.js"
import { ensureTemplate } from "../substrate/provision.js"
import { createCapacityReader } from "./capacity.js"
import { type GatewayConfig, gatewayConfig, readTelegramToken } from "./config.js"
import { TelegramDelivery } from "./delivery.js"
import { GatewayDispatcher } from "./dispatch.js"
import { BotLeader } from "./leader.js"
import { assertSchema } from "./migrate.js"
import { GatewayStore } from "./store.js"
import { TelegramClient, TelegramPoller } from "./telegram.js"

export interface GatewayDependencies {
  pool: Pool
  client: SubstrateClient
  telegram: TelegramClient
  capacity: (signal?: AbortSignal) => Promise<number>
  ensureTemplate: typeof ensureTemplate
  assertSchema: typeof assertSchema
  leader: (
    pool: Pool,
    botId: string,
  ) => Pick<BotLeader, "signal" | "acquire" | "assert" | "invalidate" | "close">
}
export interface Gateway {
  server: Server
  readonly ready: boolean
  start(signal?: AbortSignal): Promise<void>
  close(): Promise<void>
  readonly stopped: Promise<void>
}

/** Health starts first and is not ready until every admission prerequisite is verified. */
export async function createGateway(
  config: GatewayConfig,
  options: {
    healthPort?: number
    dependencies?: Partial<GatewayDependencies>
    onError?: (code: string) => void
  } = {},
): Promise<Gateway> {
  const injected = options.dependencies ?? {}
  const pool =
    injected.pool ??
    new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
    })
  const client =
    injected.client ??
    new SubstrateClient({
      caFile: config.caFile,
      api: { auth: { kind: "mtls", bundleFile: config.bundleFile } },
      router: { origin: "https://atenet-router.ate-system.svc:443", bundleFile: config.bundleFile },
    })
  const telegram =
    injected.telegram ??
    new TelegramClient({
      token: () => readTelegramToken(config.tokenFile),
      baseUrl: config.telegramBaseUrl,
    })
  const capacity =
    injected.capacity ??
    createCapacityReader({ namespace: config.namespace, poolName: config.poolName })
  const stop = new AbortController()
  let ready = false
  let started = false
  let closing: Promise<void> | undefined
  let loops: Promise<void>[] = []
  let dispatcher: GatewayDispatcher | undefined
  let leader: ReturnType<GatewayDependencies["leader"]> | undefined
  let resolveStopped: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })
  const onPoolError = () => {
    options.onError?.("database_connection_lost")
    leader?.invalidate()
    stop.abort()
    ready = false
  }
  pool.on("error", onPoolError)
  const server = createServer((request, response) => {
    const healthy = request.url === "/healthz"
    const readiness = request.url === "/readyz"
    response.writeHead(healthy || (readiness && ready) ? 200 : readiness ? 503 : 404, {
      "content-type": "application/json",
    })
    response.end(
      JSON.stringify(healthy ? { healthy: true } : readiness ? { ready } : { error: "not_found" }),
    )
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(options.healthPort ?? 8080, () => {
        server.off("error", reject)
        resolve()
      })
    })
  } catch {
    pool.off("error", onPoolError)
    await Promise.all([client.close(), pool.end()])
    throw new Error("Gateway health listener failed")
  }
  const gateway: Gateway = {
    server,
    get ready() {
      return ready
    },
    stopped,
    async start(signal) {
      if (started || stop.signal.aborted) throw new Error("Gateway cannot be restarted")
      started = true
      const startup = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
      const abort = () => {
        ready = false
        stop.abort()
      }
      signal?.addEventListener("abort", abort, { once: true })
      try {
        startup.throwIfAborted()
        await (injected.assertSchema ?? assertSchema)(pool)
        await (injected.ensureTemplate ?? ensureTemplate)(client, config.template, {
          signal: startup,
        })
        const bot = await telegram.getMe(startup)
        await telegram.assertNoWebhook(startup)
        leader = (injected.leader ?? ((pool, botId) => new BotLeader(pool, botId)))(pool, bot.id)
        await leader.acquire(startup)
        const running = AbortSignal.any([startup, leader.signal])
        leader.signal.addEventListener("abort", abort, { once: true })
        const workers = await capacity(running)
        if (!Number.isSafeInteger(workers) || workers < 0)
          throw new Error("Worker capacity is unavailable")
        await leader.assert()
        running.throwIfAborted()
        const store = new GatewayStore(pool)
        const poller = new TelegramPoller(telegram, store, config.allowedUserIds)
        const delivery = new TelegramDelivery(telegram, store)
        dispatcher = new GatewayDispatcher({
          store,
          client,
          botId: bot.id,
          atespace: config.template.atespace,
          template: config.template.name,
          egress: config.egress,
          capacity,
          maxActive: config.maxActive,
          onError: options.onError,
        })
        async function loop(code: string, fn: () => Promise<unknown>, delay: number) {
          try {
            while (!running.aborted) {
              await leader?.assert()
              running.throwIfAborted()
              await fn()
              if (delay) await sleep(delay, undefined, { signal: running })
            }
          } catch {
            if (!running.aborted) options.onError?.(code)
            abort()
          }
        }
        ready = true
        loops = [
          loop("polling_stopped", () => poller.pollOnce(running), 0),
          loop(
            "dispatch_stopped",
            () => dispatcher?.dispatchOnce(running) ?? Promise.resolve(),
            1000,
          ),
          loop("delivery_stopped", () => delivery.deliverOnce(running), 1000),
        ]
        // Loop errors are caught. Termination performs the same bounded transport drain as shutdown.
        void Promise.all(loops)
          .then(() => gateway.close())
          .catch(() => options.onError?.("gateway_shutdown_failed"))
      } catch {
        abort()
        await gateway.close()
        throw new Error("Gateway startup failed; admission is stopped")
      }
    },
    close() {
      closing ??= (async () => {
        ready = false
        stop.abort()
        await Promise.all(loops)
        await dispatcher?.drain()
        await client.close()
        await leader?.close()
        pool.off("error", onPoolError)
        await pool.end()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        resolveStopped()
      })()
      return closing
    },
  }
  return gateway
}

async function main() {
  const config = gatewayConfig()
  const shutdown = new AbortController()
  const stop = () => shutdown.abort()
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  const gateway = await createGateway(config, { onError: (code) => console.error(code) })
  try {
    await gateway.start(shutdown.signal)
    await gateway.stopped
  } finally {
    await gateway.close()
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error("Gateway stopped; configuration and durable state require inspection.")
    process.exitCode = 1
  })
}
