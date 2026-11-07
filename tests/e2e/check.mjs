// Offline harness checks only. No Kubernetes, Docker, Argo, or Actor call is made.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { redact, repeatOperation, reviewedApplication } from "./checks.mjs"

const sha = "1234567890abcdef1234567890abcdef12345678"
const app = () => ({
  spec: {
    source: { targetRevision: sha },
    destination: { server: "https://kubernetes.default.svc" },
    syncPolicy: { syncOptions: ["ServerSideApply=true"] },
  },
  status: {
    sync: { revision: sha, status: "Synced" },
    health: { status: "Healthy" },
    operationState: { phase: "Succeeded", syncResult: { revision: sha } },
  },
})

test("reviewed spec, observed revision, successful operation and health must agree", () => {
  assert.equal(reviewedApplication(app(), sha).status.health.status, "Healthy")
  for (const revision of ["main", sha.slice(0, 8), "f".repeat(40)]) {
    for (const field of ["spec", "observed", "operation"]) {
      const changed = app()
      if (field === "spec") changed.spec.source.targetRevision = revision
      else if (field === "observed") changed.status.sync.revision = revision
      else changed.status.operationState.syncResult.revision = revision
      assert.throws(() => reviewedApplication(changed, sha))
    }
  }
  const unhealthy = app()
  unhealthy.status.health.status = "Progressing"
  assert.throws(() => reviewedApplication(unhealthy, sha))
  const failed = app()
  failed.status.operationState.phase = "Failed"
  assert.throws(() => reviewedApplication(failed, sha))
  const automated = app()
  automated.spec.syncPolicy.automated = {}
  assert.throws(() => reviewedApplication(automated, sha))
})

test("repeat operation cannot change Application spec or prune data", () => {
  assert.deepEqual(repeatOperation(sha, "owned-run", ["ServerSideApply=true"]), {
    operation: {
      initiatedBy: { username: "owned-run" },
      sync: { revision: sha, prune: false, syncOptions: ["ServerSideApply=true"] },
    },
  })
  assert.throws(() => repeatOperation("main", "owned-run", []))
})

test("command failure logs remove database connection URLs and Authorization values", () => {
  const text = redact(
    "postgresql://fixture:synthetic-password@db.invalid/test Authorization: Bearer synthetic-only-key",
  )
  assert(!text.includes("synthetic-password"))
  assert(!text.includes("synthetic-only-key"))
  assert(text.includes("[database URL redacted]"))
})

test("shell entrypoint refuses a moving ref, abbreviated SHA, or absent runtime gate before tools", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  for (const args of [
    ["main", "--reviewed-runtime-gate"],
    [sha.slice(0, 8), "--reviewed-runtime-gate"],
    [sha],
    [sha, "--not-approved"],
  ]) {
    const result = spawnSync("bash", ["scripts/test-kind-app.sh", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 300_000,
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Main must review the commit/)
  }
})
