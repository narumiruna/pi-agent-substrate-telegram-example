import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { assertSchema, prepareDatabase } from "../src/gateway/migrate.js"
import { migrate, migrationChecksum, migrations } from "../src/gateway/migrations.js"
import {
  actorNameForConversation,
  type CheckpointReceipt,
  type ClaimedJob,
  conversationKey,
  GatewayStore,
  requestIdForUpdate,
  StoreConflict,
  StoreOutcomeUnknown,
} from "../src/gateway/store.js"

// Required command: bash scripts/test-postgres.sh
// Direct invocation also requires all four URLs. A missing server/credential is a failure.
function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}. Run bash scripts/test-postgres.sh`)
  return value
}
const owner = new Pool({ connectionString: required("STORE_TEST_OWNER_URL"), max: 12 })
const appUrl = required("STORE_TEST_APP_URL")
const app = new Pool({ connectionString: appUrl, max: 12 })
const admin = new Pool({ connectionString: required("STORE_TEST_ADMIN_URL") })
const substrate = new Pool({ connectionString: required("STORE_TEST_SUBSTRATE_URL") })
const store = new GatewayStore(app)
const botId = "9007199254740993"
const chatId = "-9007199254740994"
const senderId = "9007199254740995"
const actorUid = "00000000-0000-4000-8000-000000000001"
const key = conversationKey({ botId, chatId, threadId: null })
const request = (updateId = "0") => requestIdForUpdate(botId, updateId)
const options = () => ({ token: randomUUID(), leaseMs: 60_000 })

async function grants() {
  await owner.query(`GRANT USAGE ON SCHEMA gateway TO gateway_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON gateway.polling_cursors, gateway.conversations,
      gateway.inbox, gateway.jobs, gateway.outbox TO gateway_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway TO gateway_app;`)
}
async function reset() {
  await owner.query("DROP SCHEMA IF EXISTS gateway CASCADE")
  await migrate(owner)
  await grants()
}
async function accept(ids = ["0"], threadId: string | null = null) {
  const expectedOffset = await store.getCursor(botId)
  return store.acceptBatch({
    botId,
    expectedOffset,
    nextOffset: (BigInt(ids.at(-1) ?? expectedOffset) + 1n).toString(),
    updates: ids.map((updateId) => ({
      updateId,
      chatId,
      threadId,
      senderId,
      text: `input ${updateId}`,
    })),
  })
}
async function claim(conversation = key): Promise<ClaimedJob> {
  const result = await store.claimNext(conversation, options())
  expect(result).not.toBeNull()
  if (!result) throw new Error("Expected claim")
  return result
}
async function prepareSubmission(claimed: ClaimedJob) {
  await store.bindActor(claimed.ownership, actorUid)
  await store.recordAdmissionBaseline(claimed.ownership, "9007199254740995")
  await store.markSubmissionAttempted(claimed.ownership)
}
function receipt(actorName = actorNameForConversation(key)): CheckpointReceipt {
  return {
    actorName,
    actorUid,
    snapshotId: randomUUID(),
    generation: "9007199254740996",
    remoteUri: "gs://fixture-only/snapshot",
  }
}
async function checkpointIntent(claimed: ClaimedJob, confirmed: CheckpointReceipt) {
  await store.recordSuspendIntent(claimed.ownership, confirmed.generation)
  await store.observeSuspendSnapshot(claimed.ownership, confirmed)
}
async function completed(chunks = ["one", "two"]) {
  const claimed = await claim()
  await prepareSubmission(claimed)
  await store.saveResult(claimed.ownership, {
    submissionId: "submission-0",
    outcome: "succeeded",
    chunks,
  })
  const confirmed = receipt()
  await checkpointIntent(claimed, confirmed)
  await store.confirmCheckpoint(claimed.ownership, confirmed)
  return claimed
}
async function expireActorLease() {
  await owner.query(
    "UPDATE gateway.conversations SET lease_until = now() - interval '1 second' WHERE key = $1",
    [key],
  )
}
async function expireReplyLease(id: string) {
  await owner.query(
    "UPDATE gateway.outbox SET lease_until = now() - interval '1 second' WHERE id = $1",
    [id],
  )
}

/** Execute against real PG, then lose the COMMIT response (or interrupt before it). No SQL result is mocked. */
function interruptedCommit(pool: Pool, afterCommit: boolean): Pool {
  return {
    connect: async () => {
      const client = await pool.connect()
      return {
        query: async (sql: string, values?: unknown[]) => {
          if (sql === "COMMIT") {
            if (afterCommit) await client.query(sql)
            throw new Error("injected commit transport loss")
          }
          return client.query(sql, values)
        },
        release: () => client.release(),
      }
    },
  } as unknown as Pool
}

beforeAll(async () => {
  const version = await app.query<{ server_version: string }>("SHOW server_version")
  expect(version.rows[0].server_version).toMatch(/^18\./)
})
beforeEach(reset)
afterAll(async () => {
  await Promise.all([owner.end(), app.end(), admin.end(), substrate.end()])
})

describe("migration Job and Gateway readiness privileges", () => {
  it("prepares a read-only version view without exposing the ledger to the application", async () => {
    await prepareDatabase(owner, "gateway_app")
    await expect(assertSchema(app)).resolves.toBeUndefined()
    await expect(app.query("SELECT * FROM gateway.migrations")).rejects.toMatchObject({
      code: "42501",
    })
    expect(
      (
        await app.query(
          "SELECT has_table_privilege(current_user, 'gateway.schema_version', 'UPDATE') AS allowed",
        )
      ).rows[0].allowed,
    ).toBe(false)
    await expect(app.query("UPDATE gateway.schema_version SET version = 0")).rejects.toMatchObject({
      code: "55000",
    })
    await owner.query(
      "CREATE OR REPLACE VIEW gateway.schema_version AS SELECT 1::integer AS version",
    )
    await expect(assertSchema(app)).rejects.toThrow("schema version")
  })

  it("rejects administrator, owner, and invalid role names before preparing grants", async () => {
    await expect(prepareDatabase(owner, "postgres")).rejects.toThrow("restricted")
    await expect(prepareDatabase(owner, "gateway_owner")).rejects.toThrow("restricted")
    await expect(
      prepareDatabase(owner, 'gateway_app"; DROP SCHEMA gateway CASCADE;--'),
    ).rejects.toThrow("Invalid")
  })

  it("rejects a login that can assume the migration owner role", async () => {
    await admin.query("GRANT gateway_owner TO gateway_app")
    try {
      await expect(prepareDatabase(owner, "gateway_app")).rejects.toThrow("restricted")
    } finally {
      await admin.query("REVOKE gateway_owner FROM gateway_app")
    }
  })
})

describe("versioned additive migrations on real PostgreSQL", () => {
  it("migrates an empty database, validates checksums, and serializes concurrent migrations", async () => {
    await owner.query("DROP SCHEMA gateway CASCADE")
    await Promise.all([migrate(owner), migrate(owner), migrate(owner)])
    const rows = await owner.query(
      "SELECT version, name, checksum FROM gateway.migrations ORDER BY version",
    )
    expect(rows.rows).toEqual(
      migrations.map((m) => ({ version: m.version, name: m.name, checksum: migrationChecksum(m) })),
    )
    await expect(
      migrate(owner, [
        { ...migrations[0], sql: `${migrations[0].sql}\n-- changed` },
        ...migrations.slice(1),
      ]),
    ).rejects.toThrow("reconciled")
    expect(
      (await owner.query("SELECT count(*)::text AS n FROM gateway.migrations")).rows[0].n,
    ).toBe(String(migrations.length))
  })

  it("reconciles a lost migration COMMIT response by reading the atomic ledger", async () => {
    await owner.query("DROP SCHEMA gateway CASCADE")
    await expect(migrate(interruptedCommit(owner, true))).rejects.toThrow("reconciled")
    expect(
      (await owner.query("SELECT count(*)::text AS n FROM gateway.migrations")).rows[0].n,
    ).toBe(String(migrations.length))
    await migrate(owner)
    expect(
      (await owner.query("SELECT count(*)::text AS n FROM gateway.migrations")).rows[0].n,
    ).toBe(String(migrations.length))
  })

  it("upgrades version 1 without changing existing inbox, cursor, mapping, or job", async () => {
    await owner.query("DROP SCHEMA gateway CASCADE")
    await migrate(owner, migrations.slice(0, 1))
    await owner.query("INSERT INTO gateway.polling_cursors VALUES ($1, 99)", [botId])
    await owner.query(
      "INSERT INTO gateway.conversations(key,bot_id,chat_id,actor_name) VALUES ($1,$2,$3,$4)",
      [key, botId, chatId, actorNameForConversation(key)],
    )
    await owner.query(
      "INSERT INTO gateway.inbox(request_id,bot_id,update_id,conversation_key,sender_id,input_text) VALUES ($1,$2,98,$3,$4,'preserved')",
      [request("98"), botId, key, senderId],
    )
    await owner.query(
      "INSERT INTO gateway.jobs(request_id,sequence,conversation_key) SELECT request_id,sequence,conversation_key FROM gateway.inbox",
    )
    await migrate(owner)
    await grants()
    expect(await store.getCursor(botId)).toBe("99")
    expect((await store.getJob(request("98")))?.text).toBe("preserved")
    expect((await store.getConversation(key))?.actorName).toBe(actorNameForConversation(key))
    expect(await store.getOutbox(request("98"))).toEqual([])
  })

  it("rolls back failed migrations and ledger atomically on empty and existing schemas", async () => {
    const invalid = {
      version: migrations.length + 1,
      name: "invalid_test_only",
      sql: "CREATE TABLE gateway.should_rollback(id int); SELECT 1/0;",
    }
    await owner.query("DROP SCHEMA gateway CASCADE")
    await expect(migrate(owner, [...migrations, invalid])).rejects.toThrow("reconciled")
    expect(
      (await owner.query("SELECT to_regnamespace('gateway') AS schema")).rows[0].schema,
    ).toBeNull()
    await migrate(owner)
    await grants()
    await accept()
    await expect(migrate(owner, [...migrations, invalid])).rejects.toThrow("reconciled")
    expect(
      (await owner.query("SELECT to_regclass('gateway.should_rollback') AS table")).rows[0].table,
    ).toBeNull()
    expect(
      (await owner.query("SELECT count(*)::text AS n FROM gateway.migrations")).rows[0].n,
    ).toBe(String(migrations.length))
    expect((await store.getJob(request()))?.state).toBe("queued")
    await expect(migrate(owner, migrations.slice(0, 1))).rejects.toThrow("reconciled")
  })
})

describe("admission, mapping, cursor transactions", () => {
  it("deduplicates concurrent accepted batches and keeps int64 identifiers exact", async () => {
    const update = {
      updateId: "9007199254741000",
      chatId,
      threadId: null,
      senderId,
      text: "accepted",
    }
    const batch = {
      botId,
      expectedOffset: "0",
      nextOffset: "9007199254741001",
      updates: [update, update],
    }
    const results = await Promise.all(Array.from({ length: 8 }, () => store.acceptBatch(batch)))
    expect(results.filter((r) => r.status === "applied")).toHaveLength(1)
    expect(results.filter((r) => r.status === "already_applied")).toHaveLength(7)
    expect(await store.getCursor(botId)).toBe(batch.nextOffset)
    const job = await store.getJob(request(update.updateId))
    expect(job).toMatchObject({ botId, senderId, updateId: update.updateId, state: "queued" })
    expect(typeof job?.sequence).toBe("string")
    const counts = await owner.query(
      "SELECT (SELECT count(*)::text FROM gateway.inbox) AS inbox, (SELECT count(*)::text FROM gateway.jobs) AS jobs, (SELECT count(*)::text FROM gateway.conversations) AS conversations",
    )
    expect(counts.rows[0]).toEqual({ inbox: "1", jobs: "1", conversations: "1" })
    expect((await store.getConversation(key))?.actorName).toMatch(/^tg-[a-f0-9]{60}$/)
  })

  it("uses cursor CAS for competing different batches and never regresses the cursor", async () => {
    const batches = ["0", "1"].map((id) => ({
      botId,
      expectedOffset: "0",
      nextOffset: "2",
      updates: [{ updateId: id, chatId, threadId: null, senderId, text: id }],
    }))
    const result = await Promise.all(batches.map((batch) => store.acceptBatch(batch)))
    expect(result.map((r) => r.status).sort()).toEqual(["applied", "cursor_conflict"])
    expect((await owner.query("SELECT count(*)::text AS n FROM gateway.inbox")).rows[0].n).toBe("1")
    const ahead = await store.acceptBatch({
      botId,
      expectedOffset: "0",
      nextOffset: "1",
      updates: [],
    })
    expect(ahead).toEqual({ status: "already_applied", cursor: "2" })
    expect(await store.getCursor(botId)).toBe("2")
  })

  it("keeps topic/bot mappings separate and rejects conflicting duplicate input", async () => {
    await accept(["0"])
    await accept(["1"], "123")
    const topicKey = conversationKey({ botId, chatId, threadId: "123" })
    expect((await store.getConversation(topicKey))?.actorName).not.toBe(
      (await store.getConversation(key))?.actorName,
    )
    const conflicting = {
      botId,
      expectedOffset: "0",
      nextOffset: "1",
      updates: [{ updateId: "0", chatId, threadId: "123", senderId, text: "changed" }],
    }
    await expect(store.acceptBatch(conflicting)).rejects.toBeInstanceOf(StoreConflict)
    const otherBot = "1234"
    await store.acceptBatch({
      botId: otherBot,
      expectedOffset: "0",
      nextOffset: "1",
      updates: [{ updateId: "0", chatId, threadId: null, senderId, text: "different bot" }],
    })
    expect(
      (await owner.query("SELECT count(*)::text AS n FROM gateway.conversations")).rows[0].n,
    ).toBe("3")
  })

  it("checks an existing conversation mapping instead of silently accepting a changed Actor", async () => {
    await accept()
    await owner.query("UPDATE gateway.conversations SET actor_name = $2 WHERE key = $1", [
      key,
      `tg-${"a".repeat(60)}`,
    ])
    await expect(accept(["1"])).rejects.toBeInstanceOf(StoreConflict)
    expect(await store.getCursor(botId)).toBe("1")
    expect(await store.getJob(request("1"))).toBeNull()
  })

  it("rolls back all accepted work on cursor write failure, with empty and existing data", async () => {
    await owner.query(`CREATE FUNCTION gateway.reject_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected cursor failure'; END $$;
      CREATE TRIGGER reject_cursor BEFORE UPDATE ON gateway.polling_cursors
        FOR EACH ROW EXECUTE FUNCTION gateway.reject_cursor();`)
    await expect(accept()).rejects.toBeInstanceOf(StoreOutcomeUnknown)
    expect(await store.getCursor(botId)).toBe("0")
    expect(await store.listWork()).toEqual([])
    expect(await store.getConversation(key)).toBeNull()
    await owner.query("DROP TRIGGER reject_cursor ON gateway.polling_cursors")
    await accept()
    await owner.query(
      "CREATE TRIGGER reject_cursor BEFORE UPDATE ON gateway.polling_cursors FOR EACH ROW EXECUTE FUNCTION gateway.reject_cursor()",
    )
    await expect(accept(["1"])).rejects.toBeInstanceOf(StoreOutcomeUnknown)
    expect(await store.getCursor(botId)).toBe("1")
    expect(await store.getJob(request("1"))).toBeNull()
    expect((await store.getJob(request()))?.state).toBe("queued")
  })

  it("does not infer transaction outcome from a COMMIT exception; re-reads both outcomes", async () => {
    const batch = {
      botId,
      expectedOffset: "0",
      nextOffset: "1",
      updates: [{ updateId: "0", chatId, threadId: null, senderId, text: "lost response" }],
    }
    for (const committed of [false, true]) {
      await reset()
      const faulty = new GatewayStore(interruptedCommit(app, committed))
      await expect(faulty.acceptBatch(batch)).rejects.toMatchObject({
        outcome: "unknown",
        operation: "acceptBatch",
      })
      expect(await store.getCursor(botId)).toBe(committed ? "1" : "0")
      expect(await store.getJob(request())).toEqual(
        committed ? expect.objectContaining({ state: "queued" }) : null,
      )
      // Only after reconciliation can admission be retried, using the same identifiers/content.
      expect((await store.acceptBatch(batch)).status).toBe(
        committed ? "already_applied" : "applied",
      )
    }
  })

  it("rejects unsafe numeric/noncanonical IDs before writing", async () => {
    expect(() => conversationKey({ botId: "01", chatId, threadId: null })).toThrow("canonical")
    expect(() => conversationKey({ botId: "9223372036854775808", chatId, threadId: null })).toThrow(
      "int64",
    )
    expect(() => requestIdForUpdate(9007199254740992 as unknown as string, "0")).toThrow(
      "canonical",
    )
    expect(await store.listWork()).toEqual([])
  })
})

describe("fenced per-conversation ownership and reconnect recovery", () => {
  it("serializes concurrent claims, keeps one active job, and releases a proven admission failure", async () => {
    await accept(["0", "1"])
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => store.claimNext(key, options())),
    )
    const first = claims.find((c) => c !== null)
    expect(claims.filter(Boolean)).toHaveLength(1)
    if (!first) throw new Error("Missing claim")
    expect(first.job.requestId).toBe(request())
    expect((await store.getJob(request("1")))?.state).toBe("queued")
    const same = await store.claimNext(key, { token: first.ownership.token, leaseMs: 60_000 })
    expect(same?.ownership).toEqual(first.ownership)
    expect((await store.getOwnership(key))?.ownership).toEqual(first.ownership)
    await store.failKnown(first.ownership, "actor_not_created")
    expect((await store.getJob(request()))?.state).toBe("failed")
    expect((await store.getConversation(key))?.ownerToken).toBeNull()
    const next = await claim()
    expect(next.job.requestId).toBe(request("1"))
    await expect(store.recordSubmission(first.ownership, "stale")).rejects.toBeInstanceOf(
      StoreConflict,
    )
  })

  it("database constraints reject a second active job even without the application lock", async () => {
    await accept(["0", "1"])
    await claim()
    await expect(
      owner.query("UPDATE gateway.jobs SET state = 'running' WHERE request_id = $1", [
        request("1"),
      ]),
    ).rejects.toMatchObject({ code: "23505" })
  })

  it("recovers after disconnect/crash without starting the next job or losing submission identity", async () => {
    await accept(["0", "1"])
    const connection = new Pool({ connectionString: appUrl })
    const firstStore = new GatewayStore(connection)
    const first = await firstStore.claimNext(key, options())
    if (!first) throw new Error("Missing first claim")
    await firstStore.bindActor(first.ownership, actorUid)
    await firstStore.recordAdmissionBaseline(first.ownership, "0")
    await firstStore.markSubmissionAttempted(first.ownership)
    await firstStore.recordSubmission(first.ownership, "durable-existing-submission")
    await connection.end()
    await expireActorLease()
    const reconnected = new Pool({ connectionString: appUrl })
    try {
      const restarted = new GatewayStore(reconnected)
      const recovered = await restarted.claimNext(key, options())
      expect(recovered?.job).toMatchObject({
        requestId: request(),
        state: "recovery_needed",
        recoveryFrom: "running",
        submissionId: "durable-existing-submission",
      })
      expect((await restarted.getJob(request("1")))?.state).toBe("queued")
      if (!recovered) throw new Error("Missing recovered claim")
      expect(BigInt(recovered.ownership.fence)).toBeGreaterThan(BigInt(first.ownership.fence))
      await expect(
        store.saveResult(first.ownership, {
          submissionId: "durable-existing-submission",
          outcome: "succeeded",
          chunks: ["stale"],
        }),
      ).rejects.toBeInstanceOf(StoreConflict)
      await expect(
        restarted.failKnown(recovered.ownership, "pretend_not_submitted"),
      ).rejects.toBeInstanceOf(StoreConflict)
      await restarted.resumeReconciled(recovered.ownership, "running")
      expect((await restarted.getJob(request()))?.submissionId).toBe("durable-existing-submission")
      const renewed = await restarted.renew(recovered.ownership, 120_000)
      expect(renewed.ownerToken).toBe(recovered.ownership.token)
    } finally {
      await reconnected.end()
    }
  })

  it("recovers durable ownership after a real server-side connection termination", async () => {
    await accept(["0", "1"])
    const first = await claim()
    const connection = await app.connect()
    try {
      const pid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid
      const disconnected = new Promise<void>((resolve) => connection.on("error", () => resolve()))
      expect(
        (await admin.query("SELECT pg_terminate_backend($1) AS terminated", [pid])).rows[0]
          .terminated,
      ).toBe(true)
      await disconnected
    } finally {
      connection.release(true)
    }
    expect((await store.getOwnership(key))?.ownership).toEqual(first.ownership)
    await expireActorLease()
    const recovered = await claim()
    expect(recovered.job).toMatchObject({
      requestId: request(),
      state: "recovery_needed",
      submissionAttempted: false,
    })
    expect((await store.getJob(request("1")))?.state).toBe("queued")
    await expect(store.renew(first.ownership, 1000)).rejects.toBeInstanceOf(StoreConflict)
  })

  it("releases ownership into explicit recovery and keeps the uncertain active job blocking the next", async () => {
    await accept(["0", "1"])
    const first = await claim()
    await store.requireRecovery(first.ownership, "submit_response_lost")
    expect((await store.getConversation(key))?.ownerToken).toBeNull()
    const recovered = await claim()
    expect(recovered.job).toMatchObject({
      requestId: request(),
      state: "recovery_needed",
      recoveryFrom: "running",
      reason: "submit_response_lost",
    })
    await expect(
      store.resumeReconciled(recovered.ownership, "result_awaiting_checkpoint"),
    ).rejects.toBeInstanceOf(StoreConflict)
    expect((await store.getJob(request("1")))?.state).toBe("queued")
  })

  it("pins Actor UID and distinguishes crash-before-POST from an attempted POST with no received ID", async () => {
    await accept(["0", "1"])
    const first = await claim()
    await expect(store.markSubmissionAttempted(first.ownership)).rejects.toBeInstanceOf(
      StoreConflict,
    )
    await store.bindActor(first.ownership, actorUid)
    await store.bindActor(first.ownership, actorUid)
    await expect(store.bindActor(first.ownership, randomUUID())).rejects.toBeInstanceOf(
      StoreConflict,
    )
    expect((await store.getConversation(key))?.actorUid).toBe(actorUid)
    await expireActorLease()
    const beforePost = await claim()
    expect(beforePost.job).toMatchObject({
      state: "recovery_needed",
      submissionAttempted: false,
      submissionId: null,
    })
    await store.resumeReconciled(beforePost.ownership, "running")
    await store.recordAdmissionBaseline(beforePost.ownership, "0")
    await expect(
      new GatewayStore(interruptedCommit(app, true)).markSubmissionAttempted(beforePost.ownership),
    ).rejects.toBeInstanceOf(StoreOutcomeUnknown)
    expect((await store.getJob(request()))?.submissionAttempted).toBe(true)
    await expireActorLease()
    const afterPost = await claim()
    expect(afterPost.job).toMatchObject({
      state: "recovery_needed",
      submissionAttempted: true,
      submissionId: null,
    })
    // An Actor request lookup returning 404 cannot establish that external effects did not occur.
    await expect(store.failKnown(afterPost.ownership, "request_not_found")).rejects.toBeInstanceOf(
      StoreConflict,
    )
    expect((await store.getJob(request("1")))?.state).toBe("queued")
    await store.requireRecovery(afterPost.ownership, "actor_request_missing_after_attempt")
  })

  it("does not bind two conversations to the same Actor UID", async () => {
    await accept(["0"])
    await accept(["1"], "123")
    const main = await claim()
    const topic = await claim(conversationKey({ botId, chatId, threadId: "123" }))
    await store.bindActor(main.ownership, actorUid)
    await expect(store.bindActor(topic.ownership, actorUid)).rejects.toBeInstanceOf(
      StoreOutcomeUnknown,
    )
    expect((await store.getConversation(topic.conversation.key))?.actorUid).toBeNull()
    const otherUid = randomUUID()
    await store.bindActor(topic.ownership, otherUid)
    expect((await store.getConversation(topic.conversation.key))?.actorUid).toBe(otherUid)
  })

  it("a lost claim COMMIT response is reconciled by the retained token, not a second job", async () => {
    await accept(["0", "1"])
    const retained = options()
    await expect(
      new GatewayStore(interruptedCommit(app, true)).claimNext(key, retained),
    ).rejects.toBeInstanceOf(StoreOutcomeUnknown)
    const observed = await store.getOwnership(key)
    expect(observed?.ownership.token).toBe(retained.token)
    expect(observed?.job.requestId).toBe(request())
    expect((await store.getJob(request("1")))?.state).toBe("queued")
  })
})

describe("result persistence and checkpoint gate (database proof only)", () => {
  it("stores blocked chunks before checkpoint, survives owner crash, then completes/releases atomically", async () => {
    await accept(["0", "1"])
    const first = await claim()
    await prepareSubmission(first)
    const result = {
      submissionId: "existing-submission",
      outcome: "succeeded" as const,
      chunks: ["a", "b"],
    }
    await store.saveResult(first.ownership, result)
    await store.saveResult(first.ownership, result)
    expect((await store.getJob(request()))?.state).toBe("result_awaiting_checkpoint")
    expect((await store.getOutbox(request())).map((r) => r.state)).toEqual(["blocked", "blocked"])
    expect(await store.claimReply(key, options())).toBeNull()
    expect(await store.claimNext(key, options())).toBeNull()
    await expireActorLease()
    const recovered = await claim()
    expect(recovered.job).toMatchObject({
      state: "recovery_needed",
      recoveryFrom: "result_awaiting_checkpoint",
    })
    await expect(store.confirmCheckpoint(first.ownership, receipt())).rejects.toBeInstanceOf(
      StoreConflict,
    )
    await store.resumeReconciled(recovered.ownership, "result_awaiting_checkpoint")
    await expect(
      store.confirmCheckpoint(recovered.ownership, receipt(`tg-${"a".repeat(60)}`)),
    ).rejects.toBeInstanceOf(StoreConflict)
    const confirmed = receipt()
    await checkpointIntent(recovered, confirmed)
    await store.confirmCheckpoint(recovered.ownership, confirmed)
    expect((await store.getJob(request()))?.checkpoint).toEqual(confirmed)
    expect((await store.getJob(request()))?.state).toBe("completed")
    expect((await store.getOutbox(request())).map((r) => r.state)).toEqual(["pending", "pending"])
    expect((await store.getConversation(key))?.ownerToken).toBeNull()
    expect((await claim()).job.requestId).toBe(request("1"))
  })

  it("rolls back partial result chunks and partial checkpoint transitions", async () => {
    await accept()
    const first = await claim()
    await prepareSubmission(first)
    await owner.query(`CREATE FUNCTION gateway.reject_second_chunk() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.chunk_index = 1 THEN RAISE EXCEPTION 'injected chunk failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_second_chunk BEFORE INSERT ON gateway.outbox
        FOR EACH ROW EXECUTE FUNCTION gateway.reject_second_chunk();`)
    await expect(
      store.saveResult(first.ownership, {
        submissionId: "s",
        outcome: "failed",
        chunks: ["a", "b"],
      }),
    ).rejects.toBeInstanceOf(StoreOutcomeUnknown)
    expect((await store.getJob(request()))?.state).toBe("running")
    expect(await store.getOutbox(request())).toEqual([])
    await owner.query("DROP TRIGGER reject_second_chunk ON gateway.outbox")
    await store.saveResult(first.ownership, { submissionId: "s", outcome: "failed", chunks: ["a"] })
    await owner.query(`CREATE FUNCTION gateway.reject_eligibility() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected eligibility failure'; END $$;
      CREATE TRIGGER reject_eligibility BEFORE UPDATE ON gateway.outbox
        FOR EACH ROW EXECUTE FUNCTION gateway.reject_eligibility();`)
    const confirmed = receipt()
    await checkpointIntent(first, confirmed)
    await expect(store.confirmCheckpoint(first.ownership, confirmed)).rejects.toBeInstanceOf(
      StoreOutcomeUnknown,
    )
    expect((await store.getJob(request()))?.state).toBe("result_awaiting_checkpoint")
    expect((await store.getOutbox(request()))[0].state).toBe("blocked")
    expect((await store.getOwnership(key))?.ownership).toEqual(first.ownership)
  })

  it("reconciles a lost checkpoint COMMIT response without treating it as a failed checkpoint", async () => {
    await accept()
    const first = await claim()
    await prepareSubmission(first)
    await store.saveResult(first.ownership, {
      submissionId: "s",
      outcome: "cancelled",
      chunks: ["cancelled"],
    })
    const confirmed = receipt()
    await checkpointIntent(first, confirmed)
    await expect(
      new GatewayStore(interruptedCommit(app, true)).confirmCheckpoint(first.ownership, confirmed),
    ).rejects.toBeInstanceOf(StoreOutcomeUnknown)
    expect((await store.getJob(request()))?.checkpoint).toEqual(confirmed)
    expect((await store.getJob(request()))?.state).toBe("completed")
    expect((await store.getOutbox(request()))[0].state).toBe("pending")
    expect(await store.getOwnership(key)).toBeNull()
  })
})

describe("ordered Telegram outbox, send intent, receipts, and uncertainty", () => {
  it("filters eligible heads before the limit and excludes blocked/failed/uncertain/other-Bot work", async () => {
    const updates = Array.from({ length: 102 }, (_, index) => ({
      updateId: String(index),
      chatId: index === 101 ? "9999" : String(1000 + index),
      threadId: null,
      senderId,
      text: "fixture input",
    }))
    await store.acceptBatch({ botId, expectedOffset: "0", nextOffset: "102", updates })
    // Construct 101 non-deliverable head fixtures without 101 external Actor operations.
    await owner.query(
      `UPDATE gateway.jobs SET state = 'result_awaiting_checkpoint',
      submission_attempted = true, final_outcome = 'succeeded'
      WHERE request_id <> $1`,
      [request("101")],
    )
    await owner.query(
      `INSERT INTO gateway.outbox(request_id,conversation_key,sequence,chunk_index,body,state)
      SELECT request_id,conversation_key,sequence,0,'retained reply',
        CASE WHEN sequence % 3 = 0 THEN 'failed' WHEN sequence % 3 = 1 THEN 'uncertain' ELSE 'blocked' END
      FROM gateway.jobs WHERE request_id <> $1`,
      [request("101")],
    )
    const readyKey = conversationKey({ botId, chatId: "9999", threadId: null })
    const ready = await claim(readyKey)
    await prepareSubmission(ready)
    await store.saveResult(ready.ownership, {
      submissionId: "ready",
      outcome: "succeeded",
      chunks: ["ready"],
    })
    const confirmed = receipt(ready.conversation.actorName)
    await checkpointIntent(ready, confirmed)
    await store.confirmCheckpoint(ready.ownership, confirmed)
    expect(await store.listReplyConversations()).not.toContain(readyKey)
    expect(await store.listDeliverableConversations(botId)).toEqual([readyKey])
    expect(await store.listDeliverableConversations("1234")).toEqual([])
    const sending = await store.claimReply(readyKey, options())
    if (!sending) throw new Error("Missing sender")
    expect(await store.listDeliverableConversations(botId)).toEqual([])
    await expireReplyLease(sending.reply.id)
    expect(await store.listDeliverableConversations(botId)).toEqual([readyKey])
    expect(await store.claimReply(readyKey, options())).toBeNull()
    expect(await store.listDeliverableConversations(botId)).toEqual([])
  })

  it("fences concurrent send claims and preserves partial multi-chunk/job order and response IDs", async () => {
    await accept(["0", "1"])
    await completed(["first chunk", "second chunk"])
    const second = await claim()
    await prepareSubmission(second)
    await store.saveResult(second.ownership, {
      submissionId: "second",
      outcome: "succeeded",
      chunks: ["later job"],
    })
    const confirmed = receipt()
    await checkpointIntent(second, confirmed)
    await store.confirmCheckpoint(second.ownership, confirmed)
    const senders = await Promise.all(
      Array.from({ length: 8 }, () => store.claimReply(key, options())),
    )
    expect(senders.filter(Boolean)).toHaveLength(1)
    const first = senders.find((c) => c !== null)
    if (!first) throw new Error("Missing sender")
    expect(first.reply).toMatchObject({ text: "first chunk", state: "sending", chunkIndex: 0 })
    expect(first.conversation).toMatchObject({ botId, chatId, threadId: null })
    expect((await store.getReply(first.reply.id))?.state).toBe("sending")
    await store.markReplySent(first.ownership, "9007199254741001")
    const next = await store.claimReply(key, options())
    if (!next) throw new Error("Missing second chunk")
    expect(next.reply.text).toBe("second chunk")
    await expect(store.markReplySent(first.ownership, "42")).rejects.toBeInstanceOf(StoreConflict)
    await store.markReplySent(next.ownership, "9007199254741002")
    const later = await store.claimReply(key, options())
    expect(later?.reply.text).toBe("later job")
    expect((await store.getOutbox(request())).map((r) => r.responseMessageId)).toEqual([
      "9007199254741001",
      "9007199254741002",
    ])
  })

  it("retains retry_after and known permanent rejection without discarding or bypassing chunks", async () => {
    await accept()
    await completed()
    const first = await store.claimReply(key, options())
    if (!first) throw new Error("Missing sender")
    const future = new Date(Date.now() + 60_000)
    await store.retryReplyKnownFailure(first.ownership, future, "telegram_rate_limit")
    expect((await store.getReply(first.reply.id))?.retryAt).toEqual(future)
    expect(await store.claimReply(key, options())).toBeNull()
    await owner.query(
      "UPDATE gateway.outbox SET retry_at = now() - interval '1 second' WHERE id = $1",
      [first.reply.id],
    )
    const retry = await store.claimReply(key, options())
    if (!retry) throw new Error("Missing retry")
    expect(BigInt(retry.ownership.fence)).toBeGreaterThan(BigInt(first.ownership.fence))
    await store.failReplyKnownFailure(retry.ownership, "telegram_forbidden")
    expect((await store.getReply(first.reply.id))?.state).toBe("failed")
    expect((await store.getOutbox(request()))[1].state).toBe("pending")
    expect(await store.claimReply(key, options())).toBeNull()
    expect(await store.listReplyConversations()).toContain(key)
  })

  it("turns expired sending into uncertain after reconnect, never blind resends, and fences reconciliation", async () => {
    await accept()
    await completed()
    const first = await store.claimReply(key, options())
    if (!first) throw new Error("Missing sender")
    await expireReplyLease(first.reply.id)
    const reconnected = new Pool({ connectionString: appUrl })
    try {
      const restarted = new GatewayStore(reconnected)
      expect(await restarted.claimReply(key, options())).toBeNull()
      const uncertain = await restarted.getReply(first.reply.id)
      expect(await restarted.getReplyClaim(key, first.ownership.token)).toBeNull()
      expect(uncertain).toMatchObject({ state: "uncertain", reason: "sender_lost" })
      await expect(store.markReplySent(first.ownership, "123")).rejects.toBeInstanceOf(
        StoreConflict,
      )
      expect(await restarted.claimReply(key, options())).toBeNull()
      if (!uncertain) throw new Error("Missing reply")
      await restarted.resolveUncertainReply(
        uncertain.id,
        uncertain.revision,
        "operator_confirmed_receipt",
        { sent: true, responseMessageId: "9007199254741003" },
      )
      await expect(
        restarted.resolveUncertainReply(uncertain.id, uncertain.revision, "stale_operator", {
          sent: false,
          retryAt: new Date(),
        }),
      ).rejects.toBeInstanceOf(StoreConflict)
      expect((await restarted.claimReply(key, options()))?.reply.chunkIndex).toBe(1)
    } finally {
      await reconnected.end()
    }
  })

  it("records explicit uncertain send and permits retry only after evidence of non-delivery", async () => {
    await accept()
    await completed(["only"])
    const first = await store.claimReply(key, options())
    if (!first) throw new Error("Missing sender")
    await store.markReplyUncertain(first.ownership, "telegram_response_lost")
    const uncertain = await store.getReply(first.reply.id)
    if (!uncertain) throw new Error("Missing reply")
    expect(await store.claimReply(key, options())).toBeNull()
    await store.resolveUncertainReply(
      uncertain.id,
      uncertain.revision,
      "transport_proved_not_sent",
      { sent: false, retryAt: new Date(0) },
    )
    expect((await store.claimReply(key, options()))?.reply.id).toBe(first.reply.id)
  })

  it("lost send-intent or receipt COMMIT responses are reconciled without another network permission", async () => {
    await accept()
    await completed(["only"])
    const retained = options()
    await expect(
      new GatewayStore(interruptedCommit(app, true)).claimReply(key, retained),
    ).rejects.toBeInstanceOf(StoreOutcomeUnknown)
    const first = (await store.getOutbox(request()))[0]
    expect(first).toMatchObject({ state: "sending", ownerToken: retained.token })
    const reconciled = await store.getReplyClaim(key, retained.token)
    expect(reconciled?.reply).toEqual(first)
    expect(reconciled?.conversation.botId).toBe(botId)
    expect(await store.getReplyClaim(key, randomUUID())).toBeNull()
    // No send was made by this test. A real sender must reconcile this intent, not infer non-delivery.
    const owned = { id: first.id, conversationKey: key, token: retained.token, fence: first.fence }
    await expect(
      new GatewayStore(interruptedCommit(app, true)).markReplySent(owned, "9007199254741004"),
    ).rejects.toBeInstanceOf(StoreOutcomeUnknown)
    expect(await store.getReply(first.id)).toMatchObject({
      state: "sent",
      responseMessageId: "9007199254741004",
    })
    expect(await store.claimReply(key, options())).toBeNull()
    expect(await store.getReplyClaim(key, retained.token)).toBeNull()
  })
})

describe("actual PostgreSQL roles and separate-database isolation", () => {
  it("runs all application operations as a restricted role, not migration/platform/admin credentials", async () => {
    const roles = await app.query(
      "SELECT current_user, rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = current_user",
    )
    expect(roles.rows[0]).toEqual({
      current_user: "gateway_app",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    })
    await expect(app.query("SELECT * FROM gateway.migrations")).rejects.toMatchObject({
      code: "42501",
    })
    await expect(app.query("CREATE TABLE gateway.not_allowed(id int)")).rejects.toMatchObject({
      code: "42501",
    })
    await expect(app.query("SET ROLE substrate_owner")).rejects.toMatchObject({ code: "42501" })
    await expect(app.query("CREATE ROLE escape LOGIN")).rejects.toMatchObject({ code: "42501" })
    await accept()
    expect((await store.getJob(request()))?.senderId).toBe(senderId)
  })

  it("denies Gateway login to the Substrate database and keeps Substrate tables unavailable", async () => {
    const secret = await substrate.query("SELECT secret FROM substrate.private_state WHERE id = 1")
    expect(secret.rows[0].secret).toBe("fixture-only-substrate-secret")
    for (const url of [required("STORE_TEST_APP_URL"), required("STORE_TEST_OWNER_URL")]) {
      const target = new URL(url)
      target.pathname = "/substrate_test"
      const denied = new Pool({ connectionString: target.toString() })
      try {
        await expect(denied.query("SELECT * FROM substrate.private_state")).rejects.toMatchObject({
          code: "42501",
        })
      } finally {
        await denied.end()
      }
    }
    await expect(app.query("SELECT * FROM substrate.private_state")).rejects.toMatchObject({
      code: "42P01",
    })
    // Even a schema with the same name in the application DB does not grant access.
    await admin.query(
      "CREATE SCHEMA IF NOT EXISTS substrate AUTHORIZATION substrate_owner; CREATE TABLE IF NOT EXISTS substrate.local_secret(secret text)",
    )
    await expect(app.query("SELECT * FROM substrate.local_secret")).rejects.toMatchObject({
      code: "42501",
    })
  })
})
