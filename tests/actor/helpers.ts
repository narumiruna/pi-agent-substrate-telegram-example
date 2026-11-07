import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import { ActorRuntime, type ActorRuntimeOptions } from "../../src/actor/runtime.js"

export const context = BACKGROUND_CONTEXT
export const requestId = "telegram:42:100"
export const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id = name) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" })

export async function fixture(
  responses: FauxResponseStep[] = [],
  extra: Partial<ActorRuntimeOptions> = {},
) {
  const directory = extra.dataDir ?? (await mkdtemp(join(tmpdir(), "telegram-pi-actor-")))
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 })
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  const options: ActorRuntimeOptions = {
    dataDir: directory,
    identity: async () => ({ uid: "actor-a", name: "chat-a", atespace: "test" }),
    model: () => ({ models, model: { provider: "faux", modelId: "faux-1" } }),
    ...extra,
  }
  const runtime = new ActorRuntime(options)
  return {
    directory,
    runtime,
    faux,
    options,
    cleanup: async () => {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`)
    await setTimeout(5)
  }
}
export async function settled(runtime: ActorRuntime, id = requestId) {
  const result = await eventually(
    () => runtime.status(id),
    (value) => value.piStatus === "done" || value.piStatus === "unanswered",
  )
  await eventually(
    () => runtime.quiescence(),
    (value) => value.quiescent,
  )
  return result
}
export function session(runtime: ActorRuntime) {
  if (!runtime.session?.root) throw new Error("Missing initialized Actor")
  return { harness: runtime.session.harness, root: runtime.session.root }
}
