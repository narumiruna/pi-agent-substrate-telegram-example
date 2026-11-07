import { readFile } from "node:fs/promises"
import type { Model } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { rotatingProviderFetch } from "./transport.js"

export const LIMITS = Object.freeze({
  maxTurns: 12,
  modelOutputTokens: 4096,
  toolOutputBytes: 16_384,
  toolOutputLines: 400,
  bashTimeoutSeconds: 300,
  streamTimeoutMs: 120_000,
  requestBytes: 32_768,
  textBytes: 16_384,
  responseBytes: 131_072,
  httpTimeoutMs: 10_000,
  admissionQueue: 32,
})
export const PLACEHOLDER_KEY = "substrate-egress-placeholder"

/** The Gateway and Actor must use the same text admission boundary. */
export function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.isWellFormed() &&
    Buffer.byteLength(value) <= LIMITS.textBytes
  )
}

export interface ActorIdentity {
  uid: string
  name: string
  atespace: string
}

// Read projected files on use. Never capture identity in the golden process environment.
export async function projectedIdentity(): Promise<ActorIdentity> {
  const [uid, name, atespace] = await Promise.all(
    ["actor-uid", "actor-name", "atespace"].map(async (file) =>
      (await readFile(`/run/ate/identity/${file}`, "utf8")).trim(),
    ),
  )
  if (![uid, name, atespace].every((value) => value.length > 0 && value.length <= 255)) {
    throw new Error("Actor identity projection is invalid")
  }
  return { uid, name, atespace }
}

export function openAIModels(env: NodeJS.ProcessEnv = process.env) {
  if (env.OPENAI_API_KEY !== PLACEHOLDER_KEY) {
    throw new Error("Actor requires the non-secret egress placeholder key")
  }
  if (!env.OPENAI_BASE_URL || !env.OPENAI_MODEL || !env.OPENAI_MODEL_METADATA) {
    throw new Error("OPENAI_BASE_URL, OPENAI_MODEL, and OPENAI_MODEL_METADATA are required")
  }
  const baseUrl = new URL(env.OPENAI_BASE_URL)
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error("OPENAI_BASE_URL must be an HTTPS base URL without credentials or query")
  }
  const provider = openaiProvider()
  const metadata = provider.getModels().find((model) => model.id === env.OPENAI_MODEL_METADATA)
  if (metadata?.api !== "openai-responses") {
    throw new Error("Unknown OpenAI Responses model metadata")
  }
  // A deployment name can differ from the underlying model. Keep its capabilities and cost metadata.
  const model: Model<"openai-responses"> = {
    ...metadata,
    id: env.OPENAI_MODEL,
    baseUrl: env.OPENAI_BASE_URL,
    maxTokens: Math.min(metadata.maxTokens, LIMITS.modelOutputTokens),
  }
  const caFile = env.NODE_EXTRA_CA_CERTS ?? "/run/ate/egress-trust-bundle/trust-bundle.pem"
  const fetch = rotatingProviderFetch(caFile)
  const models = createModels()
  const configuredProvider: typeof provider = {
    ...provider,
    getModels: () => [model],
    stream: (model, context, options) =>
      provider.stream(model, context, Object.assign({}, options, { fetch })),
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, { ...options, fetch }),
  }
  models.setProvider(configuredProvider)
  return { models, model: { provider: "openai", modelId: model.id } }
}
