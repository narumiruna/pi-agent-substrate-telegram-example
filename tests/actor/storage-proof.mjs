import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { backup, DatabaseSync } from "node:sqlite"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  createRegistry,
  Harness,
  ProviderDoc,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"

// Test-only fixture-issued bash probe. Never open a second writable Harness on the live database.
const path = process.argv[2] ?? "/data/pi/session.sqlite"
const workspace = process.argv[3] ?? "/data/workspace"
const db = new DatabaseSync(path, { readOnly: true })
const directory = await mkdtemp("/tmp/pi-proof-")
let harness
try {
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check
  const wal = await stat(`${path}-wal`)
  const [main, log, file] = await Promise.all([
    readFile(path),
    readFile(`${path}-wal`),
    readFile(`${workspace}/fixture.txt`, "utf8"),
  ])
  const sentinel = Buffer.from("WAL and workspace sentinel")
  // Pi's storage open writes its schema-version row even for a read-only Harness.
  // Inspect a SQLite-consistent backup, never the live DB, through Pi's public APIs.
  const copy = join(directory, "session.sqlite")
  await backup(db, copy)
  const context = BACKGROUND_CONTEXT
  harness = await Harness.open(
    await openNodeSqliteStorage(copy),
    { models: createModels(), registry: createRegistry(), readOnly: true },
    context,
  )
  const root = await harness.conversation(ROOT_CONVERSATION_ID, context)
  if (!root) throw new Error("Missing root in restored database")
  const provider = await harness.snapshot(ProviderDoc, root.id, context)
  const history = await root.entries({ order: "ascending" }, 1000, undefined, context)
  if (history.next) throw new Error("Runtime proof exceeded its history bound")
  const userEntries = history.items
    .filter((entry) => entry.model?.[0]?.role === "user")
    .map((entry) => ({ id: entry.id, content: entry.model[0].content }))
  console.log(
    JSON.stringify({
      integrity,
      walBytes: wal.size,
      workspace: file,
      mainContainsSentinel: main.includes(sentinel),
      walContainsSentinel: log.includes(sentinel),
      conversationId: String(root.id),
      providerSessionId: provider?.sessionId,
      userEntries,
      rawEntryIds: history.items.map((entry) => entry.id),
    }),
  )
} finally {
  await harness?.close(BACKGROUND_CONTEXT)
  db.close()
  await rm(directory, { recursive: true, force: true })
}
