import assert from "node:assert/strict"

interface SnapshotInput {
  before: { actorUid: string }
  fidelity: number
  snapshot: { owner: number; uuid: string; durableSnapshot: { object: { snapshotUri: string } } }
}
interface LogRecord {
  msg?: string
  method?: string
  trace_id?: string
  err?: unknown
  object?: string
  logical_bytes?: number
  req?: {
    actor_uid?: string
    snapshot?: { snapshot_uuid?: string; object?: { sharing?: number; snapshot_uri?: string } }
  }
}
function records(text: string): LogRecord[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogRecord]
      } catch {
        return []
      }
    })
}

// Installed Substrate download logs omit the object name. Join by the propagated restore trace.
export function proveRemoteReads(
  snapshots: SnapshotInput[],
  ateletText: string,
  pluginText: string,
) {
  const atelet = records(ateletText)
  const plugin = records(pluginText)
  return snapshots.map((item) => {
    assert.equal(item.snapshot.owner, 1) // ACTOR -> PRIVATE, never the shared snapshot cache.
    const restore = atelet.findLast(
      (entry) =>
        entry.method === "/atelet.Atelet/Restore" &&
        entry.req?.actor_uid === item.before.actorUid &&
        entry.req?.snapshot?.snapshot_uuid === item.snapshot.uuid &&
        entry.err === null,
    )
    assert(restore?.trace_id, `No successful exact-UUID restore for ${item.snapshot.uuid}`)
    const remote = restore.req?.snapshot?.object
    assert(remote)
    assert.equal(remote.sharing, 1) // SNAPSHOT_SHARING_PRIVATE.
    assert.equal(remote.snapshot_uri, item.snapshot.durableSnapshot.object.snapshotUri)
    const uploads = plugin.filter(
      (entry) =>
        entry.msg === "Compressed zstd upload" &&
        entry.object?.includes(`/actors/${item.before.actorUid}/snapshots/${item.snapshot.uuid}/`),
    )
    const downloads = plugin.filter(
      (entry) => entry.msg === "Decompressed zstd download" && entry.trace_id === restore.trace_id,
    )
    assert(
      uploads.some((entry) => entry.object?.includes("/fs/")),
      "No uploaded durable-volume image",
    )
    if (item.fidelity === 3)
      assert(
        uploads.some((entry) => entry.object?.endsWith("/checkpoint.img.zstd")),
        "No uploaded memory checkpoint",
      )
    const sizes = (entries: LogRecord[]) =>
      entries
        .map((entry) => {
          assert.equal(typeof entry.logical_bytes, "number")
          return entry.logical_bytes ?? 0
        })
        .sort((a, b) => a - b)
    assert.deepEqual(
      sizes(downloads),
      sizes(uploads),
      `Remote downloads do not match exact snapshot files for ${item.snapshot.uuid}`,
    )
    assert(downloads.length >= (item.fidelity === 3 ? 11 : 4), "Incomplete snapshot file download")
    return {
      actorUid: item.before.actorUid,
      snapshot: item.snapshot.uuid,
      traceId: restore.trace_id,
      uri: remote.snapshot_uri,
      uploads,
      downloads,
    }
  })
}
