import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import { createRegistry, Harness } from "@earendil-works/pi-durable"
import {
  openNodeSqliteDatabase,
  openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node"
import { expect, test } from "vitest"

test("opens and closes Pi Durable with file-backed Node SQLite without model credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-pi-toolchain-"))
  const context = BACKGROUND_CONTEXT

  try {
    const path = join(directory, "session.sqlite")
    const storage = await openNodeSqliteStorage(path)
    try {
      const harness = await Harness.open(
        storage,
        { models: createModels(), registry: createRegistry() },
        context,
      )
      try {
        const inspection = await harness.inspect(context)
        expect(inspection.tasks).toEqual([])
        expect(inspection.submissions).toEqual([])
      } finally {
        await harness.close(context)
      }
      await expect(harness.closed).resolves.toEqual({ kind: "closed" })
    } finally {
      await storage.close(context)
    }

    const database = await openNodeSqliteDatabase(path)
    try {
      expect(await database.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" })
      expect(await database.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" })
    } finally {
      await database.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
