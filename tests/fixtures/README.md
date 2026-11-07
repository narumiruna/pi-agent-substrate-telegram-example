# Synthetic HTTPS fixtures

These fixtures test transport prerequisites for plan task 3. They are not an Actor, Gateway, or task-12 acceptance test. They never call an external API. Use synthetic input only.

## Run

Run from the repository root after the isolated platform bootstrap:

```sh
bash scripts/kind-fixtures.sh unit
bash scripts/kind-fixtures.sh build
bash scripts/kind-fixtures.sh deploy
bash scripts/kind-fixtures.sh check
```

`unit` needs Node 26, OpenSSL, and the pinned installed Pi AI package. It uses an ephemeral localhost certificate. It calls the installed production OpenAI provider over verified HTTPS. It submits a synthetic tool result; it does not execute an Actor tool. The file is outside the default `.test.ts` suite.

`build` uses the pinned Node 26.8.2 Linux amd64 image. It copies only the fixture server and cluster probe, with no application or package runtime. It pushes only to the owned `localhost:25071` registry and records the resulting digest in `.cache/kind/fixtures/image`.

`deploy` creates `telegram-pi-fixtures` and its `synthetic-api` Service and Deployment. It also applies `egress-upstream-roots.patch.yaml` to the pinned platform egress Deployment. This causes an egress rollout. Every cluster command uses the absolute `.cache/kind/kubeconfig` path and context `kind-telegram-pi-validation`. There is no cleanup command that can target another cluster. The existing isolated cluster cleanup removes these disposable resources.

`check` runs a direct Pod-to-Service probe. It verifies HTTPS, rejects an absent root and a wrong DNS name, and checks Telegram identity and the bounded Responses stream. It does not test Actor egress or credential injection.

## Endpoints and fixture values

| Item                        | Value                                                      |
| --------------------------- | ---------------------------------------------------------- |
| Origin                      | `https://synthetic-api.telegram-pi-fixtures.svc:443`       |
| Pod HTTPS listener          | `8443`                                                     |
| Telegram base               | `https://synthetic-api.telegram-pi-fixtures.svc`           |
| Synthetic Bot token         | `900001:fixture-only`                                      |
| Synthetic Bot ID / username | `900001` / `telegram_pi_fixture_bot`                       |
| OpenAI base                 | `https://synthetic-api.telegram-pi-fixtures.svc/openai/v1` |
| Selected catalog model      | OpenAI `gpt-5.6-luna`, Pi AI `1.5.0`, `openai-responses`   |
| Actor placeholder key       | `substrate-egress-placeholder`                             |
| Egress replacement key      | `fixture-injected-openai-key`                              |

Copy the actual catalog model and replace only `baseUrl`. The selected metadata uses `reasoning: true`, `compat.supportsStrictMode: true`, a 272000-token context window, and a 128000-token output maximum. Actor output remains capped at 4096 tokens. Do not change the API to Chat Completions. The fixture accepts only `POST /openai/v1/responses`, `stream: true`, `store: false`, and the selected model ID. The production adapter declares tools for this model through `additional_tools` input items. Direct transport probes can also use the top-level `tools` field.

For each ordinary latest user message, the fixture streams one `write` function call with `{"path":"fixture.txt","content":"fixture tool output\n"}`. The next request must contain that function call and its nonempty `function_call_output`. The fixture then streams `Fixture tool turn complete.`. It emits numbered Responses SSE events, partial argument/text deltas, `response.output_item.done`, `response.completed`, and synthetic usage. This is one bounded tool turn, not a general workflow engine.

The `actor-storage-proof:` test prefix selects one fixed `bash` command, `node /app/storage-proof.mjs`, with a 30-second timeout. The next response returns the tool's JSON proof. The script is present only in the Actor test derivative image. It inspects the actual restored database, including a SQLite-consistent backup for public Pi history APIs; it is not a substitute for a real Substrate restore.

`https://development-api.telegram-pi-fixtures.svc/development/probe` is a separate, certificate-verified development origin. It reports only fixture-known Authorization values. Its Actor policy must have no credential replacement effects.

Telegram supports GET or POST for `getMe`, `getWebhookInfo`, `getUpdates`, and `sendMessage`. Bodies can use JSON or form encoding. `getWebhookInfo` always reports no webhook. Polls repeat pending updates until a higher offset confirms them. Negative offsets are not supported. Empty long polls wait at most one second. `sendMessage` returns a synthetic message ID and retains the chat/topic. Rate limits, dropped responses, webhook transitions, and other Telegram methods are not implemented.

## Test controls and records

The test controls use the same verified HTTPS origin:

- `POST /__fixture/reset` with `{"updates": [...]}` resets all volatile records and pending updates. Use at most 100 synthetic updates with nonnegative integer `update_id` values.
- `GET /__fixture/state` returns calls, sent messages, and pending updates.
  - Each call retains its method, redacted Bot path, request body, status, selected headers, TLS SNI, and TLS version.
  - Only the two listed synthetic model Authorization values are retained. Other Authorization values are redacted. Unselected header values are not recorded.
  - The service does not print request bodies, headers, tokens, certificates, or private keys to stdout.
  - State is in memory and is lost on a Pod restart. Reset before each measured test. The service fails at 2000 recorded calls instead of silently discarding evidence.

The controls have no authentication and are test-only. Do not expose the Service outside the isolated cluster or send private input. Record counts from a direct probe do not prove credential injection. A later Actor test must show that the upstream record has the replacement value, not the Actor placeholder, and must check a destination without credential effects separately.

## Trust

The existing signer issues the Pod leaf through `servicedns.podcert.ate.dev/identity` with ECDSAP256. The Service must select the Pod before certificate issuance. The signer covers the selecting Services `synthetic-api.telegram-pi-fixtures.svc` and `development-api.telegram-pi-fixtures.svc`, not their `.svc.cluster.local` aliases. The key and chain stay in a projected Pod certificate volume. The fixture does not create or export a CA key. Restart the fixture Pod after a projected serving certificate changes; this minimal server loads it at startup.

Direct clients, including a future Gateway test, must project the live `servicedns.podcert.ate.dev/identity` ClusterTrustBundle. Use its PEM as `NODE_EXTRA_CA_CERTS` before Node starts, or pass the CA explicitly to a test HTTPS client. Never disable TLS verification.

Actor trust is different: Actors trust the projected `egress-mitm.ate.dev` and `system-roots.ate.dev` bundles. The egress upstream-origin connection must also trust the service-DNS CA. The retained test-only strategic patch combines the current custom Envoy image's public roots with the live projected service-DNS roots. It mounts no CA key and keeps hostname validation. The patch pins the same custom Envoy digest as the running platform. It must be included in the later platform Argo CD source; an imperative patch alone does not prove reconciliation. Restart egress after an origin-root update because the combined file uses an init container and a subPath mount.

The fixture does not change Router identity grants, Actor egress policies, credential-provider authorization, NetworkPolicy, sandbox settings, or host security settings. These remain separate runtime tests.
