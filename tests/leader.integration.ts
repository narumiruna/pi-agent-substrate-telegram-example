import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { describe, expect, it } from "vitest"
import { BotLeader } from "../src/gateway/leader.js"

const appUrl = process.env.STORE_TEST_APP_URL
const adminUrl = process.env.STORE_TEST_ADMIN_URL
if (!appUrl || !adminUrl)
  throw new Error("Run bash scripts/test-postgres.sh for leadership integration")

describe("exclusive Bot leadership on actual PostgreSQL sessions", () => {
  it("rejects a second session for the same Bot but allows another Bot; shutdown retires locks", async () => {
    const pool = new Pool({ connectionString: appUrl, max: 5 })
    const first = new BotLeader(pool, "500", 5)
    const second = new BotLeader(pool, "500", 5)
    const otherBot = new BotLeader(pool, "501", 5)
    try {
      await first.acquire()
      await first.assert()
      await expect(second.acquire()).rejects.toThrow("Exclusive Bot leadership")
      await otherBot.acquire()
      await first.close()
      const replacement = new BotLeader(pool, "500", 5)
      try {
        await replacement.acquire()
        await replacement.assert()
      } finally {
        await replacement.close()
      }
    } finally {
      await first.close()
      await second.close()
      await otherBot.close()
      await pool.end()
    }
  })

  it("aborts admission on a real backend termination, does not replace the connection, and permits fenced restart", async () => {
    const name = `leader-test-${randomUUID()}`
    const pool = new Pool({ connectionString: appUrl, application_name: name, max: 2 })
    const admin = new Pool({ connectionString: adminUrl })
    const leader = new BotLeader(pool, "500", 5)
    try {
      await leader.acquire()
      const pid = (
        await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE application_name = $1",
          [name],
        )
      ).rows[0]?.pid
      expect(pid).toBeTypeOf("number")
      const lost = new Promise<void>((resolve) =>
        leader.signal.addEventListener("abort", () => resolve(), { once: true }),
      )
      await admin.query("SELECT pg_terminate_backend($1)", [pid])
      await lost
      await expect(leader.assert()).rejects.toThrow()
      await expect(leader.acquire()).rejects.toThrow("cannot be reused")
      await leader.close()
      const replacement = new BotLeader(pool, "500", 5)
      try {
        await replacement.acquire()
        await replacement.assert()
      } finally {
        await replacement.close()
      }
    } finally {
      await leader.close()
      await pool.end()
      await admin.end()
    }
  })

  it("pool failure invalidates leadership and pre-aborted startup cannot take a lock", async () => {
    const pool = new Pool({ connectionString: appUrl })
    const leader = new BotLeader(pool, "500", 5)
    const aborted = new AbortController()
    aborted.abort()
    try {
      await expect(leader.acquire(aborted.signal)).rejects.toThrow()
      await leader.acquire()
      leader.invalidate()
      expect(leader.signal.aborted).toBe(true)
      await expect(leader.assert()).rejects.toThrow()
    } finally {
      await leader.close()
      await pool.end()
    }
  })
})
