import { openAIModels, projectedIdentity } from "./config.js"
import { actorServer } from "./http.js"
import { ActorRuntime } from "./runtime.js"

// The golden image starts only an HTTP listener. Writable Pi state is lazy.
const runtime = new ActorRuntime({
  dataDir: "/data",
  identity: projectedIdentity,
  model: openAIModels,
})
const server = actorServer(runtime)
server.listen(80, "0.0.0.0")
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void runtime.close()
    })
    server.closeIdleConnections()
  })
}
