import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"

// Preload only in the compiled CLI child. Do not open a connection or use the cluster.
const entry = pathToFileURL(process.argv[1])
const { SubstrateClient } = await import(new URL("./client.js", entry))
const { ActorTemplate } = await import(new URL("./generated/ateapi/v1/ateapi.js", entry))
let template
SubstrateClient.prototype.rpc = async function (method, input) {
  assert.equal(this.options.api.auth.kind, "mtls")
  assert.equal(this.options.api.auth.bundleFile, "/var/run/ate/credential-bundle.pem")
  assert.equal(this.options.caFile, "/var/run/ate/ca.crt")
  assert.equal(this.options.router, undefined)
  if (method === "createActorTemplate") {
    template = ActorTemplate.create(input.actorTemplate)
    template.metadata.uid = "00000000-0000-4000-8000-000000000001"
    template.status = {
      goldenSnapshotStatus: {
        errorMessage: "FixtureFailed: readiness rejected",
        goldenTag: undefined,
        snapshotTime: undefined,
      },
    }
    return template
  }
  assert.equal(method, "getActorTemplate")
  return template
}
