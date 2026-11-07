import { createHash } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import type { Pool, PoolClient } from "pg"

/** One session lock per stable Bot ID. A replica count is not a leadership proof. */
export class BotLeader {
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private client?: PoolClient
  private heartbeat?: Promise<void>
  private checking?: Promise<void>
  private closing = false
  private readonly key: string
  private readonly lost = () => this.controller.abort(new Error("Bot leadership lost"))
  constructor(
    readonly pool: Pool,
    botId: string,
    readonly intervalMs = 1000,
  ) {
    if (
      botId.trim() !== botId ||
      !/^[1-9][0-9]*$/.test(botId) ||
      !Number.isInteger(intervalMs) ||
      intervalMs < 1
    )
      throw new Error("Invalid Bot leader configuration")
    this.key = createHash("sha256")
      .update(`telegram-pi:bot:${botId}`)
      .digest()
      .readBigInt64BE()
      .toString()
  }
  async acquire(signal?: AbortSignal) {
    if (this.client || this.signal.aborted) throw new Error("Bot leader cannot be reused")
    signal?.throwIfAborted()
    const client = await this.pool.connect()
    this.client = client
    client.on("error", this.lost)
    client.on("end", this.lost)
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS locked",
        [this.key],
      )
      if (result.rows[0]?.locked !== true) throw new Error("Another Gateway owns this Bot")
      signal?.throwIfAborted()
      this.signal.throwIfAborted()
      this.heartbeat = this.monitor().catch(this.lost)
    } catch {
      this.lost()
      await this.close()
      throw new Error("Exclusive Bot leadership is unavailable")
    }
  }
  async assert() {
    this.signal.throwIfAborted()
    this.checking ??= this.check().finally(() => {
      this.checking = undefined
    })
    return this.checking
  }
  private async check() {
    if (!this.client || this.closing) throw new Error("Bot leadership is unavailable")
    try {
      const result = await this.client.query<{ held: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted) AS held",
      )
      if (result.rows[0]?.held !== true) throw new Error("Bot lock missing")
      this.signal.throwIfAborted()
    } catch {
      this.lost()
      throw new Error("Bot leadership is unavailable")
    }
  }
  private async monitor() {
    while (!this.signal.aborted) {
      await sleep(this.intervalMs, undefined, { signal: this.signal })
      await this.assert()
    }
  }
  /** Pool failures also stop leadership. Do not silently replace the locked session. */
  invalidate() {
    this.lost()
  }
  async close() {
    if (this.closing) return
    this.closing = true
    this.lost()
    await this.heartbeat
    await this.checking?.catch(() => {})
    const client = this.client
    this.client = undefined
    if (client) {
      // Retire this connection. Never return a possibly locked session to a pool.
      client.release(true)
    }
  }
}
