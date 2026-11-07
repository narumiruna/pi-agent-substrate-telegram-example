# Telegram Pi chart

This chart runs one Gateway with `Recreate` and two Substrate gVisor workers. It creates no Ingress, Service, LoadBalancer, database, Secret, ActorTemplate CRD, or runtime Actor resource.

## Inputs and prerequisites

Use an existing, bootstrapped Substrate platform. The explicit bootstrap boundary is `deploy/platform/PROVENANCE.md`. The platform owns `gvisor-default` SandboxConfig. This chart owns the WorkerPool CR, not its controller-created Pods.

Supply all values required by `values.schema.json`. `values.yaml` intentionally has no usable image or model defaults. For the isolated fixture cluster, use `values-kind.yaml`. Do not use kind values or its local registry in production.

- `images.gateway`, `images.actor`, and `images.worker` must include SHA256 digests. Worker and Actor images must differ.
- `substrate.actorTemplate` is an immutable, versioned API record name. Use a new name when its image, model, or egress specification changes. No old template or runtime Actor is automatically deleted or migrated.
- `openai.model` is the deployment identifier. `openai.modelMetadata` is the underlying Pi OpenAI Responses model. `openai.baseUrl` is applied explicitly. No Azure SDK or Azure-prefixed setting is used.
- `openai.credentialUri` points to the existing provider-authorized LLM Secret. Gateway, provisioner, and Actors receive only its URI and the fixed placeholder key, never the LLM key.
- `developmentHosts` contains exact lowercase HTTPS hostnames. The provisioner adds no credential effects to these rules. Telegram messages cannot change these values.
- `telegram.allowedUserIds` contains positive decimal strings. `telegram.apiBaseUrl` is an HTTPS Telegram or test-fixture endpoint.
- `existingSecrets.database` is an application DML URL. `existingSecrets.migrationDatabase` is a **different Secret** containing the owner URL. Both must identify the same application database, never the Substrate database.
- `database.applicationRole` names the existing DML role. The migration Job grants its table/sequence access and read-only schema-version view, not DDL or migration-ledger access.
- `existingSecrets.telegram` supplies only the Bot token, projected at `/var/run/telegram/token`. No token value is accepted by chart values.
- `database.namespace`, `database.podLabels`, and `database.port` identify the operator-managed in-cluster application database for egress policy. Operator owns roles, HBA, TLS, storage, and backups.

Gateway and provisioner use distinct ServiceAccounts without ambient tokens. Gateway has one namespaced `get` permission for its named WorkerPool. Its separate rotating Kubernetes token and CA projection permit only this capacity check; the provisioner has no Kubernetes RBAC. Supply `kubernetesApi.cidr` as the exact post-DNAT IPv4 `/32` endpoint and `kubernetesApi.port` for its egress rule. No Secret or worker administration permission is granted. Operator bootstrap grants API atespace `editor`. This is the narrowest built-in writable role, not a per-method grant. Only Gateway is Router-allowlisted. Both use a live service-DNS CA projection and an ECDSAP256 Pod identity credential bundle; do not use `subPath` mounts for these rotating files.

## Ordering and admission

| Argo CD wave | Resources or gate                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------- |
| -5           | Namespace API-access label, restricted ServiceAccounts, network policy                            |
| -4           | Two-worker WorkerPool; Argo custom health waits for ready workers                                 |
| -2           | Owner-credential migration Job must complete                                                      |
| -1           | Provision Job compares/creates the immutable template and waits for the completed golden snapshot |
| 0            | Gateway Deployment, with application schema/template startup guards                               |

Jobs have configuration-derived names and remain present after completion. Do not add TTL cleanup that causes Argo to recreate successful Jobs continuously. Retry failures only after the operator checks their cause. No Job opens Pi state in a golden Actor.

Argo CD enforces the waves. Helm alone creates ordinary resources concurrently: it has no equivalent sync-wave gate. The Gateway must independently refuse all admission until schema and template readiness checks pass. Do not bypass these guards or use a second poller during rollout. This chart deliberately has no Helm hook that would need workers before they exist or wait for a blocked Gateway.

`MAX_ACTIVE_DISPATCH=2` is an upper bound. Dispatch also checks ready WorkerPool capacity and all mapped Actor occupancy before new admission. Unknown capacity blocks new work, not status reconciliation. Readiness uses `/readyz:8080`. No liveness probe can restart a Gateway during uncertain work. Kubernetes HTTPS egress rules are not an FQDN firewall; application configuration and TLS constrain Telegram transport. Substrate Actor egress is independently default-deny and configured through API policies.

## Checks

```sh
bash scripts/check-deployment.sh
bash scripts/check-deployment.sh --server
```

The server check targets only context `kind-telegram-pi-validation` with the absolute repository `.cache/kind/kubeconfig`. It does not apply resources. Argo CD runtime reconciliation remains a separate gate.
