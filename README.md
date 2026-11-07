# Telegram Pi

A Telegram long-polling Gateway with isolated Pi Durable Actors on Agent Substrate.

The Gateway stores accepted updates and replies in PostgreSQL. Each chat or topic uses one Pi Durable Actor with SQLite and a workspace in Substrate durable storage. Replies wait for a confirmed remote checkpoint.

Isolated kind validation passes, including Argo CD reconciliation, Gateway restart, parallel Actor isolation, and remote memory/cold restores. Real Telegram and Azure integration remain operator checks; no production readiness is claimed.

## Checks

Use Node 26.8.2 and npm 11.19.1:

```sh
bash scripts/prepare-tools.sh
export PATH="$PWD/.cache/tools:$PATH"
npm ci
npm run ci
npm run test:postgres
npm run check:deployment
bash scripts/generate-substrate.sh --check
```

The CI gate runs Biome, strict test type checking, Vitest, and the TypeScript build. Default tests use temporary SQLite, TLS/gRPC fixtures, and offline Helm renders. The separate PostgreSQL gate creates a disposable Docker container. They need no Telegram or model credentials.

This is a private application, not an npm package. There is no publication or release command.

## Local platform

Read [operations](docs/operations.md) before creating resources. The local harness uses a separate cluster, registry, and kubeconfig. Never use the existing `kind-kind` context as a test target.

See [architecture](docs/architecture.md) for the design and [operations](docs/operations.md) for verified commands, recovery evidence, limits, and external handoff.
