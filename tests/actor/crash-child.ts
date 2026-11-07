import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { createModels } from "@earendil-works/pi-ai/models"
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { ActorRuntime } from "../../src/actor/runtime.js"
import { call, requestId } from "./helpers.js"

process.on("message", () => {})
const directory = process.argv[2]
const mode = process.argv[3]
const faux = fauxProvider({ tokensPerSecond: 1_000_000 })
faux.setResponses(
  mode === "model"
    ? [
        async () => {
          process.send?.({ ready: true })
          await new Promise(() => {})
          return fauxAssistantMessage("unreachable")
        },
      ]
    : [
        call("bash", {
          command:
            "printf '%s' \"$$\" > tool-pid.txt; printf 'effect\\n' >> effects.txt; printf ready > ready.txt; sleep 300",
        }),
        fauxAssistantMessage("finished"),
      ],
)
const models = createModels()
models.setProvider(faux.provider)
const runtime = new ActorRuntime({
  dataDir: directory,
  identity: async () => ({ uid: "actor-a", name: "chat-a", atespace: "test" }),
  model: () => ({ models, model: { provider: "faux", modelId: "faux-1" } }),
})
await runtime.submit(requestId, "crash test")
if (mode !== "model") {
  while (true) {
    try {
      await readFile(join(runtime.workspace, "ready.txt"))
      break
    } catch {
      await setTimeout(5)
    }
  }
  process.send?.({ ready: true })
}
// The parent sends SIGKILL, not Harness.close().
await new Promise(() => {})
