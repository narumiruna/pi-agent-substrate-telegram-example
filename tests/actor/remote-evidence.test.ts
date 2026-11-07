import { expect, it } from "vitest"
import { proveRemoteReads } from "./remote-evidence.mjs"

const snapshot = {
  before: { actorUid: "actor-a" },
  fidelity: 1,
  snapshot: {
    uuid: "snap-a",
    owner: 1,
    durableSnapshot: { object: { snapshotUri: "gs://bucket/a" } },
  },
}
const restore = {
  method: "/atelet.Atelet/Restore",
  trace_id: "restore-trace",
  err: null,
  req: {
    actor_uid: "actor-a",
    snapshot: { snapshot_uuid: "snap-a", object: { sharing: 1, snapshot_uri: "gs://bucket/a" } },
  },
}
const uploads = [1, 2, 3, 4].map((size, index) => ({
  msg: "Compressed zstd upload",
  object: `prefix/actors/actor-a/snapshots/snap-a/fs/${index}.zstd`,
  logical_bytes: size,
}))
const downloads = uploads.map((upload) => ({
  msg: "Decompressed zstd download",
  trace_id: "restore-trace",
  logical_bytes: upload.logical_bytes,
}))
const lines = (items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n")
it("correlates private exact-UUID remote file downloads through the restore trace", () => {
  expect(
    proveRemoteReads([snapshot], lines([restore]), lines([...uploads, ...downloads])),
  ).toHaveLength(1)
})
it("refuses shared cache, wrong snapshot, unrelated downloads, and missing files", () => {
  for (const changed of [
    {
      ...restore,
      req: {
        ...restore.req,
        snapshot: {
          ...restore.req.snapshot,
          object: { sharing: 2, snapshot_uri: "gs://bucket/a" },
        },
      },
    },
    {
      ...restore,
      req: { ...restore.req, snapshot: { ...restore.req.snapshot, snapshot_uuid: "other" } },
    },
    { ...restore, trace_id: "other-trace" },
  ])
    expect(() =>
      proveRemoteReads([snapshot], lines([changed]), lines([...uploads, ...downloads])),
    ).toThrow()
  expect(() =>
    proveRemoteReads([snapshot], lines([restore]), lines([...uploads, ...downloads.slice(1)])),
  ).toThrow()
})
