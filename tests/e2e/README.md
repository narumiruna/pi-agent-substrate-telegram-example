# Packaged application kind E2E

This suite uses the production Gateway and Actor images. Synthetic Telegram and OpenAI HTTPS endpoints replace external services. Offline tests do not establish runtime acceptance.

## Required operator gates

1. Review and commit the application, chart, platform, fixture, and harness sources. Supply the full immutable Git SHA.
2. Complete platform, enforcing CNI, separate application PostgreSQL, identity, registry, and fixture prerequisites. Build and deploy the updated fixture through `scripts/kind-fixtures.sh` before application admission. Do not replace a fixture with pending work.
3. Apply and initially sync both Argo Applications to that SHA. Wait for `substrate-platform`, then `telegram-pi`, to become `Synced` and `Healthy`. The harness does not create Applications or perform initial deployment.
4. Explicitly approve the runtime gate. Do not run another poller, reset the fixture, or send unrelated inputs during measurement.

## Commands

Run offline checks without a cluster:

```sh
node --test tests/e2e/check.mjs tests/fixtures/check.mjs
npx tsc -p tests/e2e/tsconfig.json --noEmit
bash -n scripts/test-kind-app.sh
```

After the operator opens the runtime gate:

```sh
bash scripts/test-kind-app.sh FULL_REVIEWED_GIT_SHA --reviewed-runtime-gate
```

The SHA must contain 40 lowercase hexadecimal characters. The flag records approval; it does not grant approval. All cluster commands use context `kind-telegram-pi-validation` and the absolute repository `.cache/kind/kubeconfig`. The suite checks saved node and registry ownership before writes. It never targets `kind-kind` or a shared registry.

## Measured checks

- Both Argo Applications must match the reviewed SHA in their specification, observed revision, and completed sync result. Two repeat sync operations retain that exact revision and disable pruning. Each operation waits for successful sync and health.
- The packaged Gateway must have one replica, `Recreate`, fixture-only Telegram configuration, and the `telegram-pi` WorkerPool with exactly two ready worker Pods.
- A separate restricted test client uses the Gateway ServiceAccount, projected mTLS identity, and public trust. It mounts the application DML connection URL as a private file. It mounts no Bot token or operator credential. Database evidence uses read-only transactions.
- Owned update IDs and chat/topic markers are appended without resetting previous records. Unauthorized, anonymous, and non-triggering updates advance the cursor without jobs, mappings, Actors, or model calls.
- Three authorized chat/topic Actors share the two workers. Their real tools write different content at the same workspace path. Public Pi history, provider IDs, and file content must remain separate. Observations retain actual worker assignments and bounded occupancy.
- Gateway Pod replacement starts only after all three inputs and the cursor commit, with a blocked outbox and checkpoint work in progress. Accepted work must complete without a duplicate finished seed submission. Replies must match the saved Actor UID, snapshot UUID, generation, and completed remote URI. Reuse must retain mappings, files, provider IDs, and raw history.
- Fixed fixture tool scenarios run inline diagnostics in the exact production Actor image. A read-only live SQLite handle runs `PRAGMA integrity_check`; public Pi APIs inspect only a temporary SQLite-consistent backup. The diagnostic never opens a second live writable Harness.
- Development HTTPS must succeed without Authorization injection. A disallowed HTTP authority over the same valid TLS connection must return `403` with `egress denied`, with successful allowed controls before and after. Actual Kubernetes GET requests impersonating the credential-provider ServiceAccount must permit its fixture LLM Secret and reject the Bot and storage Secrets.
- Separate disposable validation Actors use the packaged MEMORY template and a new immutable VOLUMES template. No mapped Actor or sourceTag is upgraded. Each restore requires the latest private `COMPLETED` snapshot, nonempty remote URI, safe Revert without UUID change, absent node-local checkpoint, and exact UUID/trace object-plugin download evidence. Both restore paths must retain committed live WAL, workspace, raw history IDs, provider/root IDs, settled submission, and SQLite integrity. MEMORY retains the process ID; VOLUMES changes it.
- The second reconciliation must retain application database state and public CA hashes.

## Evidence and failure handling

Each run writes `.cache/e2e/<run-id>/`: phase results, Argo status, Pod and WorkerPool records, database observations, fixture records, snapshot identifiers, remote-read traces, logs, and `summary.json`/`report.md`. It prints no database URLs, passwords, Bot tokens, certificate bundles, or private keys.

A failed check stops the suite. Missing evidence is not a pass. The client Pod, NetworkPolicy, templates, Actors, fixtures, database, and snapshots remain for inspection. There is no automatic cleanup, blind replay, cursor reset, data deletion, production image rebuild, external image publication, or host-wide change. A later run refuses undrained work or insufficient retained fixture capacity. Reconcile that condition explicitly; do not erase it to make the test pass.

Real Telegram, the supplied Azure endpoint, and production deployment remain external acceptance checks.
