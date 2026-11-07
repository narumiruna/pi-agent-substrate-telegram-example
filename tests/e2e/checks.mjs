// Pure harness checks. Passing these checks is not platform or application runtime evidence.
import assert from "node:assert/strict"

export function reviewedApplication(app, sha, ready = true) {
  assert.match(sha, /^[0-9a-f]{40}$/)
  assert.equal(app.spec.source.targetRevision, sha, "Argo Application spec is not the reviewed SHA")
  assert.equal(app.spec.destination.server, "https://kubernetes.default.svc")
  assert(!app.spec.syncPolicy?.automated, "Disable automatic sync during measured validation")
  if (ready) {
    assert.equal(
      app.status.sync.revision,
      sha,
      "Argo observed revision does not match reviewed SHA",
    )
    assert.equal(app.status.sync.status, "Synced")
    assert.equal(app.status.health.status, "Healthy")
    assert.equal(app.status.operationState?.phase, "Succeeded")
    assert.equal(app.status.operationState.syncResult.revision, sha)
  }
  return app
}

export function repeatOperation(sha, marker, syncOptions) {
  assert.match(sha, /^[0-9a-f]{40}$/)
  return {
    operation: {
      initiatedBy: { username: marker },
      sync: { revision: sha, prune: false, syncOptions },
    },
  }
}

export function redact(value) {
  return value
    .toString()
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[database URL redacted]")
    .replace(/Bearer\s+[^\s"'\\]+/g, "Bearer [redacted]")
}
