# Telegram Pi operations

## Implementation status

The Gateway, Pi Durable Actor, PostgreSQL store, and deployment resources are implemented. Packaged Argo CD validation is in progress. This is not an accepted live Telegram or production deployment. Keep the saved plan open until its required checks pass.

No real Telegram or model request is authorized by the local test procedure. Do not use the existing `kind-kind` context or shared `kind-registry` container.

## Versions and local commands

| Component                  | Selected version                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Node / npm                 | 26.8.2 / 11.19.1                                                                               |
| Pi Durable / Pi AI / Chord | 1.5.0, exact published packages                                                                |
| PostgreSQL client          | pg 8.23.1                                                                                      |
| gRPC / protobuf runtime    | grpc-js 1.14.7 / @bufbuild/protobuf 2.14.1                                                     |
| Protobuf generators        | ts-proto 2.18.4 / grpc-tools 1.13.1                                                            |
| Substrate                  | `94e0a26ac90151886a76410568aaac2664a54d90`                                                     |
| Source build toolchain     | Go 1.27.3, selected by the upstream module                                                     |
| Helm / kind                | 4.3.1 / 0.33.0, checksum-verified Linux x86_64 binaries                                        |
| Argo CD / kubectl          | 3.6.1 / 1.37.0, checksum-verified Linux x86_64 binaries                                        |
| Kubernetes node            | `kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5` |
| Local registry             | `registry:3@sha256:38907510915c3f1604c7e83d6ab602ab3020d092f73bdaed8696773693ff768c`           |

Run from the repository root:

```sh
bash scripts/prepare-tools.sh
export PATH="$PWD/.cache/tools:$PATH"
npm ci
npm run ci
bash scripts/generate-substrate.sh --check
bash scripts/test-postgres.sh
bash scripts/check-deployment.sh
bash scripts/kind-cluster.sh create
bash scripts/kind-cluster.sh status
bash scripts/bootstrap-kind.sh
```

`npm run ci` runs Biome, test type checking, Vitest, and the TypeScript build. The generated API uses `bigint` for every int64 and preserves protobuf timestamp seconds/nanoseconds. The generator checks vendored source hashes and runs without a network fetch. `--check` compares regenerated files byte for byte. Its loopback tests check wire compatibility, not platform authentication.

`skipLibCheck` applies to dependency declarations. Pi AI's transitive `@google/genai@2.21.0` declarations import an absent optional MCP SDK. Application and test sources still use strict type checking. No unused MCP dependency or Azure SDK was added. Pi Durable remains experimental; do not change its pin against existing data without a migration and recovery test.

The SQLite toolchain probe opens and closes an installed Harness without model credentials or a root conversation. It checks WAL mode and `PRAGMA integrity_check`. It does not prove Actor persistence, WAL snapshot fidelity, compaction, or process recovery.

## Platform ownership and bootstrap boundary

All upstream paths in this section refer to the selected Substrate commit. The application does not depend on a neighboring source checkout. `scripts/bootstrap-kind.sh` fetches that exact commit into ignored local storage and permits only the retained registry-name patch.

| Resource or side effect                             | Owner and required gate                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local cluster and registry                          | Local harness. Fixed unique names, dedicated kubeconfig, pinned images. Refuse replacement of existing resources.                                                                                                                                                                              |
| CRDs, RBAC, admission policy                        | Platform integration: upstream `manifests/ate-install/generated/` and `sandboxconfig-validation.yaml`. Wait for CRDs to become Established.                                                                                                                                                    |
| Control-plane namespace                             | Canonical `ate-system`; signer controller uses `podcertificate-controller-system`. Full upstream installation cannot relocate them.                                                                                                                                                            |
| Service DNS, Pod identity, PostgreSQL signing pools | Installer creates missing `service-dns-ca-pool`, `pod-identity-ca-pool`, and `postgres-ca-pool` Secrets in signer namespace. Preserve existing pools and wait for all three trust bundles. Never put random CA generation in a reconciliation template.                                        |
| Actor/JWT/MITM signing material                     | Retained `actor-id-jwt-pool`, `actor-id-ca-pool`, derived `actor-id-ca-certs`, and `egress-mitm-ca-pool` in `ate-system`. Preserve existing values and verify MITM trust-bundle publication.                                                                                                   |
| API configuration                                   | Installer creates env/config/authentication resources and applies `ate.dev/env-hash`. Authentication config is startup-only. Preserve configured issuers on ordinary redeployment.                                                                                                             |
| Substrate PostgreSQL                                | Platform owns database `atepg`, schema `substrate`, roles `substrate_owner` and `substrate_readwrite`, and certificate login users. Upstream `pkg/postgressetup/setup.sql` must run before API startup. Gateway must never reuse these identities.                                             |
| API migrations                                      | API startup runs Goose migrations with an advisory lock. Readiness must follow successful migrations. Existing unversioned tables are rejected. No automatic destructive rollback.                                                                                                             |
| Images                                              | Build every platform binary and custom Envoy image from the exact source pin into `localhost:25071`. Record resolved digests before Actor admission. Published `v1.0.0` images identify a different revision and are not substitutes.                                                          |
| gVisor assets                                       | Platform `gvisor-default` SandboxConfig selects v7, release 20261102.0; retains v6, 20261026.0. Atelet fetches and checks asset hashes. Do not substitute a distribution runsc. KVM and microVM staging are not required.                                                                      |
| RustFS                                              | Platform PVC/Deployment/Service and `rustfs-bucket-init` Job. Explicitly wait for Job completion and test disposable object put/get. Installer rollout success alone does not prove bucket availability. Upstream development credentials are fixture-only, not a deployment secret procedure. |
| Snapshot transfers                                  | Native objectstore-plugin sidecars own S3 credentials. API/atelet main processes and Actors must not receive them. Kind's snapshot URI is `gs://ate-snapshots/` even when the plugin uses S3/RustFS.                                                                                           |
| WorkerPool                                          | Application owns the Kubernetes CR; platform controller owns worker Pods and associated resources. Use two gVisor workers with digest-pinned worker images. Placement selectors match WorkerPool metadata labels.                                                                              |
| Application database                                | Application owns a separate database and login. A separate local PostgreSQL deployment avoids the platform database's restricted HBA, certificate signer, and network policy. Application migrations are not platform migrations.                                                              |
| Atespace and grants                                 | Restricted operator bootstrap identity creates these through the Substrate API. They are not Kubernetes resources. Gateway and provisioner are not global owners.                                                                                                                              |
| ActorTemplate                                       | Provisioning Job creates an immutable, versioned API record. Compare its specification on AlreadyExists; wait for golden tag readiness and a completed snapshot. Do not create Actors before this gate.                                                                                        |
| Runtime Actors and egress policies                  | Gateway creates API records, outside Helm/Argo pruning. Create the default Actor EgressPolicy before any resume or Router request. Golden policy is not inherited. No automatic Actor deletion.                                                                                                |
| Fixture origin CA                                   | Test-only platform integration adds fixture origin trust to egress without removing public roots or hostname validation. This differs from Actor trust in the MITM CA. Retain this change across reconciliation.                                                                               |
| Telemetry                                           | Upstream kind overlay installs its OTEL ConfigMap, collector, Prometheus, and Jaeger. The ConfigMap must exist before component startup.                                                                                                                                                       |

The installer is an explicit local bootstrap boundary, not proof of complete GitOps. Separate platform/Bot Argo CD reconciliation remains an implementation requirement. Never run upstream `hack/create-kind-cluster.sh` or its broad cleanup helper: they can replace the shared registry or cluster/network resources.

## Identity and network contracts

- API: `api.ate-system.svc:443`, TLS server name `api.ate-system.svc`, service `substrate.ateapi.v1.Control`. Use DNS round-robin for the headless Service.
- Router: `https://atenet-router.ate-system.svc:443`, forwarded to Actor port 80. Set `ate-target-actor: <atespace>/<actor>`.
- Project `servicedns.podcert.ate.dev/identity` CA trust, with selector `podcert.ate.dev/canarying: live`, as `/var/run/ate/ca.crt`.
- Project a `podidentity.podcert.ate.dev/identity` ECDSAP256 credential bundle as `/var/run/ate/credential-bundle.pem`. It contains the private key and certificate chain. Router ingress requires this SPIFFE identity and an exact allowlist entry.
- If API bearer authentication is used, project a token with audience `api.ate-system.svc`. A default Kubernetes API token is insufficient. mTLS takes precedence when both credentials are sent; wrong-audience tests require a token-only connection.
- Label API-client namespaces `ate.dev/api-access: "true"`. This grants network access only, not API authorization.
- Gateway SPIFFE identity is `spiffe://cluster.local/ns/telegram-pi/sa/gateway`. Provisioner must use a different ServiceAccount. Neither is the bootstrap owner.
- Minimum built-in application permission is atespace `editor`. This also permits deletion and template/tag/egress changes. Upstream has no custom verb or per-Actor role. Do not claim narrower permissions.
- Each Router-allowlisted identity can address every Actor. Gateway sender and conversation authorization remains mandatory.
- Re-read tokens for every API call. Detect atomic projected-volume replacement. Rebuild gRPC channels and HTTPS agents when CA/certificate buffers change, and retire old connections. File projection does not update existing TLS connections.
- Rotate CAs with overlap: publish new trust, issue new leaves, wait for old leaves to expire, then retire old trust. Do not delete/recreate pools as a rotation procedure.

Gateway has a separate projected Kubernetes API token for a single namespaced `get` of its named WorkerPool. It cannot read Secrets or administer workers. Configure the exact post-DNAT API endpoint `/32` and port in the chart. Dispatch checks ready capacity and mapped Actor occupancy; a configured limit of two alone is not a capacity check.

The reference credential provider starts with an empty, default-deny atespace-to-namespace policy. Narrow its Kubernetes RBAC to the intended LLM Secret and restart it when its startup-only policy changes. Put the Bot token in a different namespace. Actor egress must default-deny; only the LLM hostname rule may replace `Authorization` with `Bearer <credential>`. Development-host rules must have no credential effects.

Project Actor trust bundles `egress-mitm.ate.dev` and `system-roots.ate.dev`. Set `NODE_EXTRA_CA_CERTS` to the projected PEM path. The Actor provider transport reads this file for every HTTP request and uses a fresh verified Undici connection. It drains each response before retiring the transport. This avoids Node startup-only trust in a warm golden process. Local tests replace roots A → A+B → B in one process, then reject a leaf from retired A. No HTTP redirects or transport retries are added. The actual platform signer pools were not rotated during validation. Never disable TLS verification.

## Snapshot and recovery restrictions

A successful synchronous SuspendActor call is not sufficient evidence. An already suspended Actor is returned unchanged and can still have a PENDING snapshot. Retain conversation ownership until the intended Actor UID, latest snapshot UUID/generation, nonempty remote URI, and `COMPLETED` state agree. Do not accept an older completed generation while a newer one is pending.

Requested MEMORY fidelity is a ceiling, not a guarantee. Record actual fidelity. A resume can reuse node-local files even after remote upload completes. Remote restore tests must remove that ambiguity, then verify live WAL, history, workspace, deduplication, and SQLite integrity for both memory and cold paths.

Do not use RevertActor to repair an uncertain upload: it can discard the newest state. Do not replay non-idempotent effects or uncertain Telegram sends. Retain evidence for reconciliation. Tags own independent copies, but deleting a tag or template can invalidate Actors that still borrow its golden snapshot.

Before a stateful upgrade, stop admission, drain work, finish synchronous checkpoints, and record image/template versions, Actor/snapshot references, cursor, inbox, and outbox state. Verify application DB and SQLite-consistent backups. Never roll back a destructive schema change automatically or open a newer incompatible SQLite schema with an older Pi binary.

## Application contract and limits

Build with `npm run build`. The image commands are `npm start` for Gateway, `npm run start:actor` for Actor, `npm run migrate` for the owner-credential migration Job, and `npm run provision` for the mTLS provisioning Job. Do not start another poller against the same Bot.

Actor endpoints are internal Router endpoints:

- `POST /v1/submissions` accepts `{requestId,text}` and returns a durable submission receipt. `requestId` is `telegram:<bot_id>:<update_id>`.
- `GET /v1/submissions?requestId=...` returns the existing receipt. Status lookup does not create a root conversation.
- `GET /v1/quiescence` checks all Harness tasks, including sleeping retries and background compaction.
- `/healthz`, `/warmup`, and `/wakeup` do not initialize writable Pi state. Golden snapshots contain no conversation or provider session identity.

| Limit                                          | Value                                                   |
| ---------------------------------------------- | ------------------------------------------------------- |
| Tool rounds / model output                     | 12 / 4096 tokens                                        |
| Retained tool output                           | 16 KiB and 400 lines                                    |
| Bash / provider timeout                        | 300 seconds / 120 seconds                               |
| Durable model retries                          | 2; 1-second base delay, maximum 10-second delay         |
| Provider-internal retries / task restart limit | 0 / 3                                                   |
| Actor HTTP wait / queued admissions            | 10 seconds / 32                                         |
| Request body / input text / response body      | 32 KiB / 16 KiB / 128 KiB                               |
| Gateway RPC wait / conversation lease          | 30 seconds / 60 seconds, renewed while waiting          |
| Checkpoint wait                                | 180 seconds; timeout leaves explicit recovery state     |
| Active Gateway dispatch                        | At most 2, also bounded by verified WorkerPool capacity |
| Telegram reply chunk                           | 4096 UTF-16 units, without splitting a surrogate pair   |

A cancelled HTTP wait does not cancel durable Pi work. The Gateway submits once after recording intent, then reads the same request ID. A crash with unsafe tool intent, or a shell execution error such as a timeout or a failed file write after mutation starts, sets durable `recovery_required` and blocks later effects. A timeout cannot establish that earlier external effects did not occur.

`OPENAI_MODEL` is the deployment identifier. `OPENAI_MODEL_METADATA` must identify an installed OpenAI Responses model definition. The Actor explicitly applies `OPENAI_BASE_URL`. Only `OPENAI_API_KEY=substrate-egress-placeholder` is accepted in the Actor; the real key remains in the provider-authorized Secret. The supplied Azure endpoint and its actual deployment/model mapping remain unverified.

## Gateway state and recovery

The application database stores admission and delivery state, not a second Pi transcript. Its DML login cannot own the database/schema, perform migrations, or read the migration ledger. The owner Job applies additive migrations and grants a read-only version view.

- Polling stores accepted updates and the next offset in one transaction. On a lost commit response, read the cursor and accepted job identities before acknowledging another offset. Never assume rollback from an exception.
- A dedicated PostgreSQL session advisory lock selects one Gateway per stable Bot ID. Connection loss stops admission and local waits; do not silently replace the leader session.
- Each conversation has fenced ownership, a pinned Actor UID, and one active job. Record the Actor generation and submission intent before POST. An attempted request that cannot be found enters recovery; it is not automatically submitted again.
- Final results create blocked outbox chunks. Record suspend generation intent and the observed snapshot UUID. Release chunks only after the exact Actor UID and latest intended generation/UUID have a nonempty remote URI and `COMPLETED` state.
- Outbox send intent is committed before HTTP. Save each returned Telegram message ID. A known 429 schedules `retry_after`; a known permanent error remains `failed` and blocks later chunks.
- An expired send intent or lost send response is `uncertain`, never an automatic resend. Operator resolution uses `resolveUncertainReply` with the current revision and explicit sent/not-sent evidence. Do not infer delivery from process restart or absence of a receipt.
- `recovery_needed` and `result_awaiting_checkpoint` retain their input, result, mapping, and intent. Resolve against Actor/Pi/API evidence before admitting the next job. Do not clear ownership or reset the cursor to hide a failure.

There is no exactly-once guarantee across Pi tools, PostgreSQL, RustFS, and Telegram. Preserve an uncertain effect rather than repeat it.

## Local safety and cleanup

The harness uses only cluster `telegram-pi-validation`, context `kind-telegram-pi-validation`, registry `telegram-pi-validation-registry`, loopback port 25071, and `.cache/kind/kubeconfig`. Every cluster command supplies both context and kubeconfig. `kind` commands supply the cluster name.

The node needs certificate/trust feature gates and proxy ARP. Proxy ARP is changed only inside the new node. gVisor workers require scoped SYS_ADMIN/NET_ADMIN capabilities, private writable delegated cgroup v2, and Unconfined seccomp/AppArmor, not a privileged-worker workaround. Do not change host security settings without an explicit administrator action.

The initial kindnet CNI does not enforce NetworkPolicy. A rendered or applied NetworkPolicy is not enforcement evidence. Install and test an enforcing policy provider before claiming denied network paths.

```sh
bash scripts/kind-cluster.sh delete
```

Cleanup checks the saved Docker node ID and registry ownership label before removal. It never removes the shared Docker network or the existing `kind-kind` resources. Cluster deletion destroys disposable PostgreSQL and RustFS data; it is not a backup operation. Local source, tool, and build caches remain under `.cache/`.

## Verification record

- Baseline `npm ci`: passed. Baseline `npm run ci`: failed at Biome formatting; tests/build did not run through that gate. Formatting corrections do not waive the gate.
- Exact dependency clean install, strict test typecheck, SQLite probe, and generated-client build: passed.
- Pinned-schema regeneration and 16 loopback protobuf/gRPC contract tests: passed. These are not authentication tests.
- Pinned Helm/kind preparation and isolated cluster readiness: passed. Existing cluster/registry were not replaced.
- Platform bootstrap: passed two complete gVisor/Router smoke runs, API migrations, RustFS put/get, and actual MEMORY checkpoints. Worker Pods are not privileged; writable delegated cgroup v2 and scoped capabilities were verified.
- Calico policy-only enforcement: positive traffic passed, denied traffic failed, and allowed traffic still passed. This is runtime enforcement evidence, not only a manifest check.
- Identity suite: 20 platform checks passed, including bearer/mTLS grants, wrong audience, missing/unlisted identities, denied ingress without Actor resume, and genuine projected token/leaf replacement in the same process. Local TLS tests also check two-root rollover. CA-buffer reload does not claim an actual platform signer/root rotation.
- Actor gate: the complete main-agent runtime rerun passed remote MEMORY and VOLUMES restores. Before checkpoint, both SQLite WAL files were 931152 bytes with the committed sentinel absent from the main file and present in WAL. Raw history, request/submission IDs, provider identity, workspace, and `PRAGMA integrity_check=ok` survived.
  - MEMORY Actor UID `d3ba0f2e-f048-4789-8e95-0970177a98ef`, private generation 2 UUID `6adc7295-7cb9-491c-8ee7-2c2e13a1a165`: process instance retained; 11 remote logical files verified.
  - Cold Actor UID `2b3736d2-3800-4eb1-804a-db3b0cc207c5`, VOLUMES generation 2 UUID `bc30b771-9a93-4fe4-b0ab-d103ef81ba80`: process instance changed; 4 remote logical files verified.
  - Exact latest completed Actor-owned snapshots were reverted only after upload completion. Local checkpoint removal and PRIVATE snapshot sharing excluded the shared cache path. Restore trace IDs and file-size sets correlate plugin downloads with those UUIDs.
- Current source gates: `npm run ci` passes 249 default tests, 7 HTTPS fixture tests, strict type checks, Biome, and build. The separate PostgreSQL harness passes 113 cases across five suites. Offline E2E safety and bootstrap checks pass 10 cases. Review fixes cover suspend workflow re-entry, capacity after restart, partial-effect timeout/write failures, corrected edit validation, text admission, trust refresh, and explicit permanent provisioning recovery.
- Production Actor and Gateway image builds and local pushes pass. Helm lint, 21 deployment tests, pinned platform reproduction, and server-side dry-runs pass. The final PostgreSQL run passes 110 cases across five suites. Packaged Argo CD reconciliation remains open. Do not interpret the focused checks as task 12 completion.

## External handoff

| Responsible role     | Required action and expected evidence                                                                                                                                                     | Restriction                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot owner            | Supply a dedicated Bot token as a private Kubernetes Secret, numeric User ID allowlist, and webhook/poller status. Verify group privacy, mentions, replies, and topics with the real Bot. | Never send secrets in chat or Git. Do not remove a webhook or start a competing poller without approval. Synthetic fixtures cannot verify account settings.            |
| Azure resource owner | Supply the key privately, deployment name, underlying model metadata, and approval for one bounded tool-turn request against `https://national-team.openai.azure.com/openai/v1`.          | Use OpenAI provider configuration, not Azure-prefixed variables. No billed request or real endpoint success claim before authorization and evidence.                   |
| Deployment operator  | Supply development-host allowlist and explicit non-local target/change approval, storage, backup, and sizing requirements. Verify network/runtime enforcement and recovery suitability.   | No production rollout, cloud provisioning, private Git credentials, or destructive data changes are authorized. Local success does not establish production readiness. |
