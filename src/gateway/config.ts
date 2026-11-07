import { readFileSync } from "node:fs"
import {
  buildActorEgressPolicy,
  buildActorTemplate,
  type EgressConfig,
  type TemplateConfig,
} from "../substrate/provision.js"

export interface GatewayConfig {
  databaseUrl: string
  tokenFile: string
  allowedUserIds: string[]
  telegramBaseUrl: string
  template: TemplateConfig
  egress: EgressConfig
  caFile: string
  bundleFile: string
  maxActive: number
  namespace: string
  poolName: string
}
/** Fail before any admission. Validation errors never contain deployment values or secrets. */
export function gatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  function required(name: string) {
    const value = env[name]
    if (!value) throw new Error(`Missing ${name}`)
    if (/[\r\n]/.test(value)) throw new Error(`Invalid ${name}`)
    return value
  }
  const databaseUrl = required("DATABASE_URL")
  try {
    if (!["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol)) throw new Error()
  } catch {
    throw new Error("Invalid DATABASE_URL")
  }
  const allowedUserIds = required("TELEGRAM_ALLOWED_USER_IDS")
    .split(",")
    .map((id) => id.trim())
  if (allowedUserIds.some((id) => !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))))
    throw new Error("Invalid Telegram sender allowlist")
  const telegramBaseUrl = env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org"
  try {
    const url = new URL(telegramBaseUrl)
    if (
      /[\r\n]/.test(telegramBaseUrl) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error()
  } catch {
    throw new Error("Invalid Telegram API base URL")
  }
  const template: TemplateConfig = {
    atespace: required("SUBSTRATE_ATESPACE"),
    name: required("ACTOR_TEMPLATE"),
    image: required("ACTOR_IMAGE"),
    openAIBaseUrl: required("OPENAI_BASE_URL"),
    openAIModel: required("OPENAI_MODEL"),
    openAIModelMetadata: required("OPENAI_MODEL_METADATA"),
    workerPoolLabel:
      env.WORKER_POOL_LABEL === undefined ? "telegram-pi" : required("WORKER_POOL_LABEL"),
  }
  if (env.DEVELOPMENT_HOSTS === undefined) throw new Error("Missing DEVELOPMENT_HOSTS")
  if (/[\r\n]/.test(env.DEVELOPMENT_HOSTS)) throw new Error("Invalid DEVELOPMENT_HOSTS")
  const egress: EgressConfig = {
    openAIBaseUrl: template.openAIBaseUrl,
    llmCredentialUri: required("LLM_CREDENTIAL_URI"),
    developmentHosts:
      env.DEVELOPMENT_HOSTS === ""
        ? []
        : env.DEVELOPMENT_HOSTS.split(",").map((host) => host.trim()),
  }
  try {
    buildActorTemplate(template)
    buildActorEgressPolicy(template.atespace, egress)
  } catch {
    throw new Error("Invalid Actor template or egress configuration")
  }
  const maxActiveText = env.MAX_ACTIVE_DISPATCH ?? "2"
  if (maxActiveText.length !== 1 || !/^[12]$/.test(maxActiveText))
    throw new Error("MAX_ACTIVE_DISPATCH must be 1 or 2")
  const namespace = required("POD_NAMESPACE")
  const poolName = env.WORKER_POOL_NAME ?? "telegram-pi"
  if (
    [namespace, poolName].some(
      (value) => /[\r\n]/.test(value) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value),
    )
  )
    throw new Error("Invalid WorkerPool address")
  return {
    databaseUrl,
    tokenFile: env.TELEGRAM_TOKEN_FILE ?? "/var/run/telegram/token",
    allowedUserIds,
    telegramBaseUrl,
    template,
    egress,
    caFile: env.SUBSTRATE_CA_FILE ?? "/var/run/ate/ca.crt",
    bundleFile: env.SUBSTRATE_CREDENTIAL_BUNDLE ?? "/var/run/ate/credential-bundle.pem",
    maxActive: Number(maxActiveText),
    namespace,
    poolName,
  }
}
export function readTelegramToken(path: string): string {
  try {
    const token = readFileSync(path, "utf8").trim()
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error()
    return token
  } catch {
    throw new Error("Unable to read Telegram token configuration")
  }
}
