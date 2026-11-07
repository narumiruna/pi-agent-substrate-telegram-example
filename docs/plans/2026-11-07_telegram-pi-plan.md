# Telegram Pi Implementation Plan

Status: In progress. Tasks 1–8 and 10 have passing focused evidence. Task 12 Argo CD validation and task 13 final checks remain open. Actual remote memory and cold Actor restore checks pass, including live WAL. No live Telegram, real model endpoint, or production acceptance is claimed.

## Goal

Implement the design in [architecture.md](../architecture.md): a Telegram long-polling Gateway that routes each authorized chat or topic to an isolated Substrate Actor running Pi Durable. Store Actor conversations in SQLite, Gateway delivery state in PostgreSQL, and Actor snapshots in RustFS. Provide Helm and Argo CD resources and verify them on an isolated kind cluster without real Telegram or model credentials.

Agent-plan completion establishes the tested local implementation, not acceptance of the real Telegram Bot, the supplied Azure endpoint, or production deployment.

## Context

- `src/index.ts`, `src/hello.ts`, and `tests/index.test.ts` are a Hello World template. No Bot, Actor, images, charts, or database migrations exist.
- `package.json` defines `npm run ci` as Biome, Vitest, and TypeScript build. `.github/workflows/ci.yml` currently runs only `npm ci`. `scripts/pre-commit.sh` runs mutating Biome commands, not the full CI script. Do not rely on either as evidence that tests ran.
- Node 26.8.2, npm 11.19.1, Go 1.27.1, Docker 29.7.2, and kubectl are available. Docker responds. Helm, kind, and the Argo CD CLI are not on PATH; prepare the required local tools during execution rather than treating their absence as an external test requirement.
- The existing Kubernetes context is `kind-kind`. It is not an authorized test target. Use an explicitly named, isolated cluster and registry; do not reuse or replace existing resources.
- Pi sources were reviewed at `b556cfe5b`; Substrate sources at `94e0a26a`. These are evidence references, not verified package or image release pins. Builds must not depend on adjacent working checkouts.

## Architecture and Scope

- Gateway: one TypeScript process with polling, dispatch, and reply delivery; one replica with `Recreate`.
- Actor: `@earendil-works/pi-durable`, `pi-ai`, `CodingTools`, `NodeExecutionEnv`, and one SQLite-backed root conversation per chat/topic.
- LLM configuration: `OPENAI_BASE_URL` and `OPENAI_API_KEY` with the OpenAI provider. Keep the supplied Base URL configurable and explicitly apply it to the Pi model. Do not add Azure-prefixed configuration or a second model client.
- Secrets: Bot token stays in the Gateway. The Actor uses a placeholder key; Substrate egress injects the real OpenAI Authorization header for the LLM destination only.
- Storage: `/data/pi/session.sqlite`, its SQLite sidecars, and `/data/workspace/` are in `DurableDir`. Gateway and Substrate retain separate PostgreSQL databases and roles. RustFS stores snapshots, not a directly mounted SQLite database.
- Kubernetes owns the infrastructure and WorkerPool. Substrate owns ActorTemplate and Actor API records. Runtime Actors must not be pruned by Helm or Argo CD.
- Initial input/output is text. Do not add attachments, webhook support, MCP integrations, automatic Actor deletion, production HA, private Git credentials, or a general-purpose workflow engine.

Keep tightly coupled Gateway logic together under `src/gateway/`, Actor logic under `src/actor/`, and shared Substrate integration under `src/substrate/`. Add files only when they separate a responsibility or make tests clearer. Expected deployment artifacts are `charts/telegram-pi/`, a pinned platform integration, `deploy/argocd/`, and a local kind test script.

## Plan

Tasks are dependency-ordered. Leave downstream work open and blocked when a prerequisite fails. Do not replace a failed runtime check with a rendered manifest or a skipped test.

- [x] **1. Establish the application toolchain and dependency pins.**
  - Work: Replace template package identity and entry points with an ESM Gateway/Actor application; pin published, compatible Pi Durable, Pi AI, and Chord packages, plus the minimum PostgreSQL and gRPC dependencies. Prepare pinned Helm and kind tools locally. Add no runtime Azure SDK.
  - Evidence: a clean `npm ci`, a recorded baseline `npm run ci` result, an import/open/close SQLite probe using the installed packages, and documented tool/image versions. Resolve or record baseline failures; do not waive required checks.

- [x] **2. Resolve Substrate contracts and bootstrap ownership before building clients or charts.**
  - Work: Read the pinned API, authentication, authorization, Router, installer, and snapshot contracts. Establish the TypeScript protobuf-generation path, API service DNS, trust projection, token/certificate refresh, API namespace labels, atespace grants, and Envoy Router identity allowlist. Map every required installer side effect to a platform resource, Job, or explicit bootstrap prerequisite, including certificate/trust setup, API startup migrations, sandbox assets, RustFS buckets, and image availability.
  - Evidence: reproducible generated-client compilation, fake-server contract tests, and a retained ownership/version matrix in `docs/operations.md`. An unimplemented bootstrap prerequisite must remain visible; do not claim complete GitOps by copying manifests.

  - Result: `npm ci` and the corrected `npm run ci` pass (17 tests). The installed SQLite probe passes WAL mode and integrity checks. Exact package/tool pins, baseline formatting failure, code-generation provenance, and bootstrap ownership are retained in `docs/operations.md`; 16 independent protobuf/gRPC contract tests pass. Runtime services remain in later tasks.

- [x] **3. Prepare an isolated local validation platform.**
  - Work: Create a named test cluster and registry using the pinned upstream kind requirements, including certificate and trust-bundle feature support. The upstream script uses a shared `kind-registry` name and can replace it; do not run it unmodified against existing resources. Install the pinned Substrate platform, PostgreSQL, RustFS, and two gVisor workers through the explicit bootstrap boundary from task 2. Add synthetic Telegram and OpenAI-compatible fixtures; trust the fixture HTTPS origin without disabling TLS checks.
  - Evidence: readiness and migration checks, a usable RustFS bucket, a test Actor reachable through the Router, and recorded sandbox/CNI capabilities. Every cluster command specifies the test context. Cleanup targets only resources created by the test harness.

- [x] **4. Prove Gateway identity and authenticated Substrate access.**
  - Work: Implement the smallest shared gRPC/HTTPS client against the local platform, with distinct Gateway and provisioning permissions. Select the Envoy Router path that enforces SPIFFE mTLS; API bearer authentication alone does not authorize Router ingress. Handle projected credential rotation and recycle affected client connections.
  - Evidence: authorized calls succeed; missing credentials, wrong audience, unlisted Router identities, and insufficient API grants fail; rotation works without restarting the process. Check that denied ingress does not resume an Actor. Keep application routing authorization because the Router allowlist is not per-Actor authorization.

- [x] **5. Implement and prove the Pi Durable Actor and storage boundary.**
  - Work: Add a bounded HTTP submit/status/quiescence contract backed by one Harness and root conversation. Use Pi settings for finite run and output limits; document and test the limits. Use `telegram:<bot_id>:<update_id>` as `requestId`; use Pi's existing submission on retry. Configure OpenAI Base URL/model metadata, CodingTools, and workspace execution without a second agent loop. Initialize writable Pi state only after the Actor is instantiated; a golden memory snapshot must not clone an already-created conversation or provider session identity into every Actor.
  - Evidence: deterministic Pi faux-provider tests cover all four tools, repeated request IDs, process interruption/reopen, preserved raw history after compaction, and distinct state/provider identities in two Actors. Local Substrate tests capture committed, uncheckpointed WAL data, perform both memory and cold restores from completed RustFS snapshots rather than only node-local cache, preserve history/workspace, and return `ok` from `PRAGMA integrity_check`. Record actual snapshot fidelity. Gate later dispatch work on these results.

- [x] **6. Implement the Gateway PostgreSQL store and state transitions.**
  - Work: Add versioned application migrations for the polling cursor, accepted inbox updates, unique conversation mapping, job state, and reply outbox. Define per-conversation ownership and recovery states, including result-awaiting-checkpoint and uncertain outcomes. Use application credentials that cannot access Substrate tables.
  - Evidence: integration tests on real disposable PostgreSQL verify migrations from empty and existing schemas, rollback on failed transactions, duplicate/concurrent inserts, ownership release on failure, and recovery after reconnect. Do not infer a failed transaction's outcome from an exception alone.

- [x] **7. Implement Telegram polling, authorization, and trigger filtering.**
  - Work: Fetch Bot identity, poll sequentially, and atomically store accepted updates with the next offset before acknowledging them to Telegram. Filter by numeric sender ID, private chat or exact Bot mention/reply, and stable Bot/chat/thread keys. Do not use forwarded attribution or usernames as authorization. Refuse polling when an existing webhook needs an explicit transition; never drop pending updates.
  - Evidence: fixture tests cover duplicate batches, mixed authorized/rejected updates, restart before/after commit, topic separation, Bot token rotation with stable mapping, anonymous/service messages, and UTF-16 mention offsets. Rejected and non-triggering messages create no Actor work and enter no Pi history.

- [x] **8. Implement retry-safe ActorTemplate provisioning and Actor creation.**
  - Work: Add a provisioning Job entry point that creates immutable, versioned API records, handles `AlreadyExists` by comparing the expected specification, and waits for the golden snapshot to become ready. Create conversation Actors with deterministic, valid names and a unique stored mapping. Do not shell out to kubectl in request handling or treat API records as CRDs.
  - Evidence: repeated/concurrent provisioning and a lost create response produce one matching record; conflicts, golden-build errors, and readiness timeouts fail explicitly; retrying Actor creation returns the same mapping. Confirm image digests and snapshot locations are resolved.

  - Results: the isolated platform passes migrations, RustFS put/get, gVisor execution, enforced CNI, and Router checks. Identity checks pass 20 runtime cases. The final Actor runtime rerun preserves WAL, raw history, identities, workspace, and SQLite integrity through MEMORY and VOLUMES remote restores. PostgreSQL component and dispatch integration passes 102 cases; provisioning passes 84 contract cases. Telegram and delivery unit checks pass 37 cases. Final dispatch review fixes pass 110 real PostgreSQL cases, including both suspend-intent crash gaps. Both production images build and push only to the isolated registry. Helm lint/schema/policy tests and server-side dry-runs pass. Packaged Argo CD reconciliation remains open.

- [x] **9. Implement serialized dispatch, checkpoint gating, and crash recovery.**
  - Work: Route submissions through `atenet-router` with `ate-target-actor`. Reattach after HTTP timeout instead of submitting a fresh job; cancelling a Gateway wait must not cancel durable Actor work. Wait for the final submission outcome and Harness quiescence, persist a non-deliverable result, complete synchronous suspend, then make the outbox entry deliverable. Bound active dispatch by available capacity.
  - Evidence: failure injection at admission, submission, result persistence, suspend, and completion boundaries shows one active run per Actor, no reply before confirmed remote checkpoint, and continued work after Gateway restart. Lost state or uncertain external effects enter an explicit recovery condition instead of blind replay. Background compaction/retry work must not be stranded by suspend.

- [x] **10. Implement durable reply delivery.**
  - Work: Send eligible outbox entries to the saved chat/topic, preserve conversation order, split plain-text replies within Telegram limits without splitting Unicode characters, and honor `retry_after`. Save Telegram response identifiers. Distinguish a known failed send from an unknown outcome after a lost response.
  - Evidence: fixtures verify routing, ordering, rate limits, partial multi-message delivery, crash recovery, and explicit uncertain-delivery handling. Do not claim exactly-once sends or silently discard failed replies.

- [x] **11. Package images, Helm resources, and Argo CD Applications.**
  - Work: Build minimal Gateway/provisioning and Actor images with pinned runtime/dependency versions and the Actor's required coding tools. Provide `charts/telegram-pi/`, `values-kind.yaml`, and separate platform/Bot Argo CD Applications using the ownership boundary proven in tasks 2–4. Pin the upstream platform resources and represent supported bootstrap operations explicitly. Order database migration and ActorTemplate readiness before Gateway admission. Add existing Secret references, restricted service accounts, Router identity grants, projected CA trust, WorkerPool, and LLM/development egress rules.
  - Evidence: local image builds, `helm lint`, template/schema checks against pinned CRDs, and policy assertions show one Gateway replica with `Recreate`, no application Ingress/LoadBalancer, no real secret values or Actor administration credentials, and no LLM credential injection on development-host rules. Changes must not silently rotate CAs or delete data/Actors.

- [ ] **12. Verify the complete deployment through local Argo CD reconciliation.**
  - Work: Run the packaged application and platform boundary on the isolated cluster with a synthetic Telegram transport and the production Pi OpenAI adapter calling the HTTPS model fixture. Do not substitute the faux provider for this network/credential-injection check. Test three chat/topic Actors sharing two workers, file/tool execution, checkpoint/reuse, Gateway restart, and both restore paths. Reconcile the same revision twice.
  - Evidence: recorded Argo CD health/sync status, Actor and snapshot identifiers/fidelity, fixture call counts, SQLite integrity results, and before/after data checks demonstrate no lost accepted work, no cross-topic history, no duplicate completed submission, and stable CAs/mappings. Allowed development destinations succeed; denied destinations and unauthorized credential reads fail. Do not treat an unapplied or unenforced NetworkPolicy as enforcement evidence.

- [ ] **13. Connect repository checks and prepare operations/handoff evidence.**
  - Work: Make `.github/workflows/ci.yml` run the existing `npm run ci` gate and add deterministic store/Actor tests plus image/chart checks. Add documented commands for the disposable PostgreSQL and isolated kind suites; distinguish required local runtime checks from credential-dependent live checks. Record safe secret setup, actual model/deployment mapping, Bot privacy requirements, limits, failure states, backup/restore, and cleanup in `docs/operations.md`.
  - Evidence: run the documented local commands and required gates from a clean install; inspect generated images/manifests/test logs for fixture-only credentials; perform a checkpoint recovery drill on disposable data. Prepare the External Handoff below without claiming its live checks passed. Do not trigger npm publication or a remote registry release.

## Completion Checklist

- [ ] Tasks 1–13 have passing evidence; no material client, identity, bootstrap, storage, or recovery question remains hidden behind a skipped test.
- [ ] The final source passes `npm run ci`, disposable PostgreSQL integration checks, image builds, Helm validation, and the isolated kind/Argo CD suite. Record exact added script names and results in the operations document.
- [ ] Authorization, polling cursor transactions, submission deduplication, serialized suspend, and uncertain delivery/effect handling pass the specified failure tests.
- [ ] SQLite history and workspace survive actual remote memory and cold restores, including live WAL; compaction retains older transcript entries and Actor identities remain separate.
- [ ] LLM secret isolation, certificate rotation, denied ingress/egress, and repeat reconciliation have runtime evidence, not only configuration assertions.
- [ ] `docs/operations.md` retains unresolved external checks, responsible roles, deployment restrictions, and recovery instructions. No real Telegram/Azure success or production readiness is claimed without evidence.

Once all checks pass, preserve any remaining external handoff in the operations document, then delete this completed plan. Do not delete it while implementation or agent-verifiable tests remain incomplete.

## Rollback / Recovery

- Before a stateful upgrade, stop new admission, drain known work, complete synchronous checkpoints, and record image/template versions, snapshot references, application database state, cursor, and outbox status. Obtain a verified application database backup and SQLite-consistent backup or retained snapshot before changing storage schemas.
- Prefer additive Gateway migrations. Do not use an automatic Helm rollback to reverse destructive database changes, delete runtime Actors, regenerate signing CAs, or erase PVCs/RustFS data.
- If a Pi Durable upgrade changes SQLite schema incompatibly, do not run an older binary on that database. Use the compatible image or restore a verified pre-upgrade copy, with application job state reconciled before admitting work.
- For an uncertain run or Telegram send, retain evidence and reconcile its status. Do not reset the polling cursor or replay non-idempotent work to make the queue look empty.
- Restore tests operate on disposable data. Local teardown must name only the test cluster, registry, containers, and temporary storage created by this plan; never delete the existing `kind-kind` context's resources or shared `kind-registry`.

## External Handoff

These items are not agent completion checkboxes. No secrets should be sent in chat or committed to the repository.

| Responsible role     | Prerequisite and action                                                                                                                                                                                                                                         | Expected result and unverified behavior                                                                                                                                     | Restriction                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot owner            | Create/provide a dedicated test Bot, allowlisted User IDs, and a Kubernetes Secret through a private local procedure; confirm whether a webhook or another poller already uses the token. Configure group privacy/membership so mentions/replies reach the Bot. | Real long polling, group/topic update delivery, mention visibility, and return-topic behavior are confirmed. Synthetic fixtures cannot establish Telegram account settings. | Do not remove an existing webhook or start a competing poller without approval. Do not declare the live Bot ready before this check.                                         |
| Azure resource owner | Provide the API key through the approved Secret procedure, deployment name and underlying model, and approval for a bounded live request against the supplied Base URL.                                                                                         | The selected Pi OpenAI model definition authenticates, streams, and completes a tool turn through real egress credential injection.                                         | No billed request or credential-dependent success claim without approval and credentials. The live endpoint remains unverified until tested.                                 |
| Deployment operator  | Supply the final development-host allowlist and, for any non-local deployment, explicit target access, storage/backup requirements, and change approval.                                                                                                        | Actual Git/package access, supported sandbox/runtime and CNI behavior, storage retention, resource sizing, and rollback suitability are confirmed.                          | This plan authorizes no production rollout, private Git credential setup, cloud provisioning, or destructive data change. Local success does not establish these properties. |

If execution discovers an unavailable host capability that the agent cannot safely prepare, record the required administrator action here and leave affected agent tasks open and blocked. Do not turn missing local test evidence into a passed check.

## Evidence References

- Repository: `docs/architecture.md`, `package.json`, `tsconfig.json`, `.github/workflows/ci.yml`, `scripts/pre-commit.sh`.
- Pi `b556cfe5b`: `packages/durable/README.md`, `packages/durable/test/examples/12-recovery.ts`, `packages/durable/test/examples/16-coding-tools.ts`, and `packages/ai/README.md` (faux-provider tests).
- Substrate `94e0a26a`: `docs/guides/authentication.md`, `docs/guides/authorization.md`, `cmd/atenet/internal/router/README.md`, `cmd/ate-setup/internal/steps/deploy.go`, `hack/create-kind-cluster.sh`, `api/ateapi/v1/ateapi.proto`, and `internal/e2e/suites/demo/demo_test.go`.
