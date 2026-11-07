# Substrate client identity checks

## Scope

`src/substrate/client.ts` provides bounded unary gRPC calls and Actor HTTPS requests. It does not implement provisioning, dispatch, Actor serialization, checkpoint validation, or application authorization.

- The API default is `dns:///api.ate-system.svc:443`. TLS verifies `api.ate-system.svc` against the configured service-DNS CA file. The gRPC channel uses round-robin DNS balancing and disables retries.
- Select API bearer authentication or API mTLS. A bearer client never presents its Router certificate to the API. The API uses the certificate principal instead of the bearer principal when both are present.
- The Gateway uses a fixed configured HTTPS Router origin. Each request sets `ate-target-actor: <atespace>/<actor>`. Both names must be DNS labels with at most 63 characters. Request paths cannot supply another origin. Redirects are not followed. There is no direct worker path.
- Use separate Gateway and provisioner clients, ServiceAccounts, and grants. Omit Router configuration on the provisioner. Do not grant either workload global owner or bootstrap owner.
  - At this Substrate pin, the minimum write role is atespace `editor`. This role also permits deletion and template, tag, and egress policy changes. There are no custom verb grants or per-Actor grants.
  - The Envoy Router SPIFFE allowlist is not per-Actor authorization. The Gateway must check Telegram sender and conversation authorization before API or Router calls.
- Credentials are read by pathname for each operation. Token replacement does not require a new channel. Changed CA or certificate buffers create a new channel or HTTPS Agent. Retired transports close after their bounded active calls finish.
  - Use one projected PEM bundle for the key and certificate chain. Publish overlapping CA trust before issuing new leaves. Do not rotate signer pools by deleting Secrets.
- Each call has a 30-second default deadline. `timeoutMs` accepts integers from 1 through 300000. HTTPS responses have a 1 MiB limit. An error or timeout does not prove that a remote effect failed.
- AbortSignal cancels only the caller's wait. The underlying bounded call continues. `close()` stops admission and waits for active calls before connection retirement. Do not use transport failure as a reason to replay durable Actor effects.

## Automatic local tests

```sh
npm exec vitest run tests/substrate-client.test.ts tests/substrate-contract.test.ts
npm run typecheck:test
npm run build
```

`tests/substrate-client.test.ts` uses real local gRPC/TLS and HTTPS/mTLS servers. OpenSSL creates temporary certificates. Tests cover file replacement, leaf and CA rotation, connection drain, deadlines, abort, response size, DNS-label validation, and no effect retries. The authorization handlers are synthetic. These tests are not evidence of platform authentication.

## Required platform suite

Do not run this suite until main confirms both task 3 platform smoke and synthetic HTTPS fixture readiness. Do not change the task order after a failed prerequisite.

Prerequisites:

- Only `kind-telegram-pi-validation`, with absolute `.cache/kind/kubeconfig` in this repository.
- The platform smoke Actor is `telegram-pi-platform-smoke/counter-smoke`. Coordinate exclusive use with the smoke operator. It must have an explicit default EgressPolicy and a completed golden snapshot.
- Namespace `telegram-pi` has `ate.dev/api-access: "true"`.
- The operator creates these ServiceAccounts and atespace editor bindings:
  - `gateway`: bearer principal `system:serviceaccount:telegram-pi:gateway` and SPIFFE principal `spiffe://cluster.local/ns/telegram-pi/sa/gateway`.
  - `identity-provisioner`: only SPIFFE principal `spiffe://cluster.local/ns/telegram-pi/sa/identity-provisioner`.
  - `identity-ungranted`: no API grants.
- Only the Gateway SPIFFE identity is on the Envoy Router ingress allowlist. The runner never writes API policies or Router configuration.

After explicit approval, run from the repository root:

```sh
node tests/identity/run.mjs --task3-ready
```

The runner builds the retained Dockerfile, pushes only to the isolated local registry, and records the digest. Its Dockerfile-specific ignore file excludes credentials, caches, and unrelated sources. Every Kubernetes command specifies the context and absolute kubeconfig. The runner refuses to replace existing identity test Pods.

`tests/substrate-identity.ts` is separate from automatic `*.test.ts` files. It verifies allowed API and Router access, missing and wrong-audience API credentials, ungranted API identities, missing Router certificates, and genuine but unlisted Router SPIFFE certificates. It compares the suspended Actor UID and latest completed snapshot after denied requests. It then proves allowed Router resume and leaves a new completed checkpoint.

Rotation uses two real Kubernetes-projected, Pod-bound Gateway tokens and two real podidentity-signed Gateway leaves. The test atomically replaces a writable projected-volume copy in one Node process and retains the same client objects. Test credentials move through subprocess memory and stdin, not host files or command arguments. Only short-lived test identities are transferred; bootstrap credentials are never mounted. This is a test fixture, not an application credential distribution method.

The CA-buffer refresh check retains the actual service-DNS roots. It proves reconnect with changed trust buffers. It is not a test of signer pool rotation, new platform roots, or scheduled kubelet renewal. Local TLS fixtures separately test a full old-root/new-root overlap and leaf change.

The runner removes only its four `identity-*` Pods. It does not remove ServiceAccounts, grants, the smoke Pod, Actors, snapshots, or platform resources. Evidence remains in `.cache/identity/image.txt`, `.cache/identity/pods.json`, and `.cache/identity/runtime.log`. Failure remains a failure; do not replace runtime evidence with unit test results.
