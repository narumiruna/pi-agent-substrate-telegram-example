# Argo CD applications

`applications.yaml` separates the retained local platform from the Bot chart. No auto-sync, automatic prune, Application deletion finalizer, Secret, or Substrate API record is included. Projects allow only the listed resource kinds and namespaces.

Before use:

1. Complete the explicit operator prerequisites in `../platform/PROVENANCE.md`. Create existing Secrets privately. Do not reconcile an unprepared platform.
2. Install Argo CD through a separately reviewed pinned installation. This directory does not install Argo CD or configure cluster credentials.
3. Merge the health keys from `health.yaml` into `argocd/argocd-cm`. WorkerPool health must wait for ready replicas and resolved sandbox classes. Application health makes the platform-before-Bot waves effective when an operator uses a parent Application.
4. Replace both `REPLACE_WITH_REVIEWED_PACKAGING_COMMIT` revisions with the immutable commit containing these artifacts. Uncommitted local files cannot be a remote Git pin. For a local Git fixture, use a validation-only repository override and adjust both project source allowlists. Do not replace the exact Substrate source pin.
5. Review both `values-kind.yaml` and `values-live.yaml`. The supplied Bot Application applies them in that order. It uses the owned local infrastructure with real Telegram and Azure OpenAI endpoints. Sync requires real credentials in the selected Secrets and approval for live API traffic. The local platform is not a production installation. For an existing Bot Application, update its Helm `valueFiles` list as well as `targetRevision`; changing the revision alone does not select the live overlay. The Bot Application does not manage its own Application object.
6. Sync `substrate-platform` and wait for `Synced` and `Healthy`. Then sync `telegram-pi`. Applying two Application objects directly does not itself order their sync operations; the waves apply only under a parent sync with Application health support.
7. Check migration completion, template provisioning completion, two ready workers, and Gateway readiness. For synthetic task-12 validation, use only `values-kind.yaml` and synthetic Secret values, then reconcile the same revision twice and compare retained state. Do not run the synthetic E2E workload against a live Bot.

Stateful platform resources, the Bot Namespace, and the WorkerPool carry `Prune=false,Delete=false`. Old template versions and runtime Actors are API records outside either Application. Upgrade and removal require the checkpoint/backup procedure in `docs/operations.md`; removing a resource from Git is not a database or Actor migration.

No Argo CD runtime result is implied by schema checks or these example Applications.
