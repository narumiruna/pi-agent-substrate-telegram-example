import { createHash } from "node:crypto"
import type { Pool } from "pg"

export interface Migration {
  version: number
  name: string
  sql: string
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "admission_and_job_ownership",
    sql: `
CREATE TABLE gateway.polling_cursors (
  bot_id bigint PRIMARY KEY CHECK (bot_id > 0),
  next_offset bigint NOT NULL CHECK (next_offset >= 0)
);
CREATE TABLE gateway.conversations (
  key text PRIMARY KEY,
  bot_id bigint NOT NULL CHECK (bot_id > 0),
  chat_id bigint NOT NULL CHECK (chat_id <> 0),
  thread_id bigint CHECK (thread_id > 0),
  actor_name text NOT NULL UNIQUE CHECK (actor_name ~ '^tg-[a-f0-9]{60}$'),
  actor_uid uuid UNIQUE,
  fence bigint NOT NULL DEFAULT 0,
  owner_token uuid,
  lease_until timestamptz,
  UNIQUE NULLS NOT DISTINCT (bot_id, chat_id, thread_id),
  CHECK ((owner_token IS NULL) = (lease_until IS NULL))
);
CREATE TABLE gateway.inbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  bot_id bigint NOT NULL,
  update_id bigint NOT NULL CHECK (update_id >= 0),
  conversation_key text NOT NULL REFERENCES gateway.conversations(key),
  sender_id bigint NOT NULL CHECK (sender_id > 0),
  input_text text NOT NULL,
  UNIQUE (bot_id, update_id)
);
CREATE TABLE gateway.jobs (
  request_id text PRIMARY KEY REFERENCES gateway.inbox(request_id),
  sequence bigint NOT NULL UNIQUE REFERENCES gateway.inbox(sequence),
  conversation_key text NOT NULL REFERENCES gateway.conversations(key),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN
    ('queued', 'running', 'result_awaiting_checkpoint', 'completed', 'failed', 'recovery_needed')),
  revision bigint NOT NULL DEFAULT 0,
  submission_id text,
  submission_attempted boolean NOT NULL DEFAULT false,
  final_outcome text CHECK (final_outcome IN ('succeeded', 'failed', 'cancelled')),
  recovery_from text CHECK (recovery_from IN ('running', 'result_awaiting_checkpoint')),
  reason text,
  checkpoint jsonb,
  CHECK ((state = 'recovery_needed') = (recovery_from IS NOT NULL)),
  CHECK (submission_id IS NULL OR submission_attempted),
  CHECK (state <> 'result_awaiting_checkpoint' OR (final_outcome IS NOT NULL AND submission_attempted)),
  CHECK (state <> 'completed' OR (final_outcome IS NOT NULL AND checkpoint IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_job_per_conversation ON gateway.jobs(conversation_key)
  WHERE state IN ('running', 'result_awaiting_checkpoint', 'recovery_needed');
CREATE INDEX jobs_conversation_order ON gateway.jobs(conversation_key, sequence);
`,
  },
  {
    version: 2,
    name: "checkpoint_gated_reply_chunks",
    sql: `
CREATE TABLE gateway.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text NOT NULL REFERENCES gateway.jobs(request_id),
  conversation_key text NOT NULL REFERENCES gateway.conversations(key),
  sequence bigint NOT NULL REFERENCES gateway.inbox(sequence),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  body text NOT NULL CHECK (length(body) > 0),
  state text NOT NULL DEFAULT 'blocked' CHECK (state IN ('blocked', 'pending', 'sending', 'sent', 'uncertain', 'failed')),
  revision bigint NOT NULL DEFAULT 0,
  fence bigint NOT NULL DEFAULT 0,
  owner_token uuid,
  lease_until timestamptz,
  retry_at timestamptz NOT NULL DEFAULT now(),
  response_message_id bigint,
  reason text,
  UNIQUE (request_id, chunk_index),
  CHECK ((state = 'sending') = (owner_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((owner_token IS NULL) = (lease_until IS NULL)),
  CHECK ((state = 'sent') = (response_message_id IS NOT NULL))
);
CREATE INDEX outbox_conversation_order ON gateway.outbox(conversation_key, sequence, chunk_index);
CREATE UNIQUE INDEX one_sender_per_conversation ON gateway.outbox(conversation_key) WHERE state = 'sending';
`,
  },
  {
    version: 3,
    name: "checkpoint_generation_intent",
    sql: `
ALTER TABLE gateway.jobs
  ADD COLUMN admission_generation bigint CHECK (admission_generation >= 0),
  ADD COLUMN suspend_generation bigint CHECK (suspend_generation > admission_generation),
  ADD COLUMN suspend_snapshot_id uuid,
  ADD CONSTRAINT checkpoint_intent_pair CHECK
    (suspend_snapshot_id IS NULL OR suspend_generation IS NOT NULL);
-- Old attempted jobs have no admission receipt. Never infer their checkpoint from current state.
UPDATE gateway.jobs SET
  recovery_from = CASE WHEN state = 'recovery_needed' THEN recovery_from ELSE state END,
  state = 'recovery_needed', reason = 'unknown_admission_baseline', revision = revision + 1
WHERE submission_attempted AND state IN ('running', 'result_awaiting_checkpoint', 'recovery_needed');
UPDATE gateway.conversations c SET owner_token = NULL, lease_until = NULL
WHERE EXISTS (SELECT 1 FROM gateway.jobs j WHERE j.conversation_key = c.key
  AND j.state = 'recovery_needed' AND j.reason = 'unknown_admission_baseline');
`,
  },
]

export function migrationChecksum(migration: Migration): string {
  return createHash("sha256").update(migration.sql).digest("hex")
}

/** No down migrations. All pending migrations and their ledger entries commit together. */
export async function migrate(pool: Pool, definitions: readonly Migration[] = migrations) {
  for (const [index, migration] of definitions.entries()) {
    if (migration.version !== index + 1 || !migration.name || !migration.sql) {
      throw new Error("Migration versions must be contiguous and start at 1")
    }
  }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(782134, 6)")
    await client.query("CREATE SCHEMA IF NOT EXISTS gateway")
    await client.query(`CREATE TABLE IF NOT EXISTS gateway.migrations (
      version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    const applied = await client.query<{ version: number; name: string; checksum: string }>(
      "SELECT version, name, checksum FROM gateway.migrations ORDER BY version",
    )
    for (const [index, row] of applied.rows.entries()) {
      const expected = definitions[index]
      if (
        !expected ||
        row.version !== expected.version ||
        row.name !== expected.name ||
        row.checksum !== migrationChecksum(expected)
      ) {
        throw new Error(`Migration ledger mismatch at version ${row.version}`)
      }
    }
    for (const migration of definitions.slice(applied.rowCount ?? 0)) {
      await client.query(migration.sql)
      await client.query(
        "INSERT INTO gateway.migrations(version, name, checksum) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migrationChecksum(migration)],
      )
    }
    await client.query("COMMIT")
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {})
    // A COMMIT response can be lost. Reconnect and inspect the ledger before another migration call.
    throw new Error("Migration outcome must be reconciled from gateway.migrations", { cause })
  } finally {
    client.release()
  }
}
