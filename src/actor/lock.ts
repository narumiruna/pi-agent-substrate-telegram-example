import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { createServer } from "node:net"
import { basename, dirname, join } from "node:path"

/** Linux abstract sockets give a process-lifetime exclusive lock, released even on SIGKILL. */
export async function lockDatabase(database: string): Promise<() => Promise<void>> {
  const canonical = join(await realpath(dirname(database)), basename(database))
  const key = createHash("sha256").update(canonical).digest("hex")
  const server = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(`\0telegram-pi-${key}`, () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  server.unref()
  return () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
}
