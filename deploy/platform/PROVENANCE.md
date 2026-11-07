# Retained local platform boundary

This directory is a **post-bootstrap kind integration**, not a complete platform installer or a production platform configuration.

## Source and reproduction

- Upstream: <https://github.com/agent-substrate/substrate>.
- Commit: `94e0a26ac90151886a76410568aaac2664a54d90`.
- License: Apache-2.0, retained in `LICENSE`.
- `vendor/` contains readable, resolved resources derived from that commit. `source.sha256` records source inputs. `images.lock.json` records locally built digests, not release `v1.0.0` images.
- The only change allowed in `.cache/substrate` is `kind-registry.patch`. This changes the registry name to `telegram-pi-validation-registry:5000`.
- Reproduce with `node tests/deployment/vendor-platform.mjs`. Verify without writing with `node tests/deployment/vendor-platform.mjs --check`.
- These commands require the bootstrap source checkout, `kubectl`, and the pinned npm dependencies. They do not read cluster Secrets or fetch moving upstream manifests.

| Retained file                     | Upstream input                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `vendor/infrastructure.yaml`      | `manifests/ate-install/generated/*.yaml`, `sandboxconfig-validation.yaml`, `sandboxconfig-gvisor.yaml` |
| `vendor/signer.yaml`              | `manifests/ate-install/pod-certificate-controller.yaml`                                                |
| `vendor/postgres.yaml`            | `manifests/ate-install/kind/postgres/`                                                                 |
| `vendor/system.yaml`              | `manifests/ate-install/kind/`                                                                          |
| `vendor/egress.yaml`              | `manifests/ate-install/atenet-egress.yaml`                                                             |
| `vendor/credential-provider.yaml` | `manifests/egress-credential-injection/k8s-credential-provider.yaml`                                   |

## Reviewed changes

- Resolve every workload image to its existing local digest. Keep the two-worker gVisor image distinct from the Pi Actor image.
- Exclude the upstream `ate-client` ServiceAccount and bucket bootstrap Job. Never retain a Secret resource or generated certificate.
- Replace RustFS public fixture credentials in RustFS and object-store sidecars with `ate-system/rustfs-credentials`, keys `access-key` and `secret-key`. Explicit `value: null` removes the old installer literal during server-side adoption.
- Exclude the upstream credential-provider ClusterRole **and ClusterRoleBinding**. Retain only `telegram-pi-llm/openai-fixture` read permission in `provider-access.yaml`. Keep the atespace namespace policy and Secret label selector. The Bot token is outside that namespace.
- Retain the installer-required API bootstrap owner `system:serviceaccount:ate-system:substrate-bootstrap` and IDP issuer `https://idp.ate-system.svc`. The owner is operator-only, not a workload identity. Both use explicit empty preview gates.
- Before first Argo adoption, run `bash scripts/adopt-platform-kind.sh`. It verifies every old RustFS environment value against the existing Secret before changing only those references. Argo server-side diff drops explicit null values and cannot perform this initial literal-to-reference change itself. Repeat adoption makes no changes.
- Admit only `spiffe://cluster.local/ns/telegram-pi/sa/gateway` through the Router. The provisioner has API access, not Router admission.
- Retain the exact test-only fixture origin trust patch from `tests/fixtures/egress-upstream-roots.patch.yaml`. It adds the live service-DNS roots to public roots. It does not disable hostname or certificate checks. Do not use this patch as a production trust policy.
- Add sync waves and `Prune=false,Delete=false` to retained upstream resources. Stateful data and CRDs require an explicit removal procedure. Do not add an Application deletion finalizer.

## Required operator boundary

Complete and verify `scripts/bootstrap-kind.sh`, policy enforcement, fixtures, and `scripts/bootstrap-application-kind.sh` before platform reconciliation. The latter creates atespaces and grants through the API; these are not CRDs.

The following remain explicit prerequisites:

1. Create and retain the service-DNS, Pod identity, PostgreSQL, Actor identity, JWT, and MITM signing pools. Verify published trust bundles. Never regenerate pools on reconciliation.
2. Prepare the Substrate database, roles, certificate identities, and HBA. Preserve installer-created API authentication/configuration resources and startup migration readiness. Retained Deployments reference these resources; they do not recreate them.
3. Create the RustFS bucket and verify object put/get. Create `rustfs-credentials` privately before adopting the retained resources. Use the same fixture credential values as the bootstrapped disposable instance; no values are retained here.
4. Build all exact-pin local images, make the isolated registry reachable, and verify the pinned gVisor assets. The cluster, enforcing CNI, registry, and assets are not installed by this Kustomization.
5. Create and label the existing LLM Secret, application database roles/URLs, and Telegram token. Never grant the provider access to the Telegram Secret. Never put an operator bearer token in Git or a workload.
6. Create application atespace/grants with the operator identity. Confirm Gateway and provisioner have only atespace `editor`; this built-in role is broader than individual method permission.
7. Before reconciliation, confirm the upstream cluster-wide Secret-reader binding is absent. `scripts/bootstrap-application-kind.sh` removes it. This directory will not recreate it.

The provider reads its policy at startup. An operator must restart it after a policy change. Changes to a live fixture CA can also require an egress rollout to rebuild the combined origin-roots file. These actions are not automatic CA rotation procedures.

Server-side dry-run validates schema and adoption only. It does not prove Argo CD reconciliation, remote Actor recovery, network enforcement, or task 12 completion.
