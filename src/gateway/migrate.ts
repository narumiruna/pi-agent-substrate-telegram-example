import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Pool } from "pg"
import { migrate, migrations } from "./migrations.js"

export const SCHEMA_VERSION = migrations.length

/** Operator Job only. The Gateway uses a separate DML-only database login. */
export async function prepareDatabase(pool: Pool, applicationRole: string): Promise<void> {
  if (
    applicationRole.length > 63 ||
    /[^a-z0-9_]/.test(applicationRole) ||
    !/^[a-z]/.test(applicationRole)
  )
    throw new Error("Invalid application role")
  const roles = await pool.query<{ safe: boolean }>(
    `SELECT candidate.rolcanlogin AND NOT EXISTS (
       SELECT 1 FROM pg_roles parent
       WHERE (parent.rolsuper OR parent.rolcreatedb OR parent.rolcreaterole OR parent.rolreplication
         OR parent.rolbypassrls OR parent.rolname = current_user
         OR parent.oid = (SELECT datdba FROM pg_database WHERE datname = current_database())
         OR parent.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'gateway'))
         AND pg_has_role(candidate.oid, parent.oid, 'MEMBER')
     ) AS safe FROM pg_roles candidate WHERE candidate.rolname = $1`,
    [applicationRole],
  )
  if (roles.rows[0]?.safe !== true)
    throw new Error("A separate restricted application login is required")
  await migrate(pool)
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(782134, 6)")
    // Owner-backed aggregate view: app can check readiness, not read the ledger.
    await client.query(`CREATE OR REPLACE VIEW gateway.schema_version AS
      SELECT COALESCE(MAX(version), 0)::integer AS version FROM gateway.migrations`)
    await client.query(`GRANT USAGE ON SCHEMA gateway TO "${applicationRole}"`)
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON gateway.polling_cursors,
      gateway.conversations, gateway.inbox, gateway.jobs, gateway.outbox TO "${applicationRole}"`)
    await client.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway TO "${applicationRole}"`,
    )
    await client.query(`GRANT SELECT ON gateway.schema_version TO "${applicationRole}"`)
    await client.query("COMMIT")
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {})
    throw new Error("Database preparation outcome requires a ledger and grant check", { cause })
  } finally {
    client.release()
  }
}

export async function assertSchema(pool: Pool): Promise<void> {
  const result = await pool.query<{ version: number }>("SELECT version FROM gateway.schema_version")
  if (result.rows.length !== 1 || result.rows[0].version !== SCHEMA_VERSION) {
    throw new Error("Application schema version does not match this image")
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 })
  pool.on("error", () => {
    process.exitCode = 1
  })
  try {
    await prepareDatabase(pool, process.env.DATABASE_APPLICATION_ROLE ?? "telegram_pi_gateway")
    console.log(`Application schema ${SCHEMA_VERSION} and restricted database grants are ready.`)
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error("Database preparation failed. Reconcile its ledger and grants before retrying.")
    process.exitCode = 1
  })
}
