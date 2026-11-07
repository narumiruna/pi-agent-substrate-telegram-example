import { readFileSync } from "node:fs"
import { request } from "node:https"

export class CapacityUnavailable extends Error {
  constructor() {
    super("Worker capacity could not be verified")
  }
}

export interface CapacityOptions {
  namespace: string
  poolName: string
  caFile?: string
  tokenFile?: string
  /** Trusted test transport override, never Telegram input. */
  origin?: string
}

function label(value: string) {
  return (
    value.length > 0 &&
    value.length <= 63 &&
    !/[^a-z0-9-]/.test(value) &&
    !value.startsWith("-") &&
    !value.endsWith("-")
  )
}

/** Read only the named WorkerPool. No worker administration or Secret access. */
export function createCapacityReader(options: CapacityOptions) {
  if (!label(options.namespace) || !label(options.poolName))
    throw new Error("Invalid WorkerPool reference")
  const origin = new URL(options.origin ?? "https://kubernetes.default.svc")
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Kubernetes API must be a trusted HTTPS origin")
  }
  const path = `/apis/ate.dev/v1/namespaces/${options.namespace}/workerpools/${options.poolName}`
  return async (signal?: AbortSignal): Promise<number> => {
    signal?.throwIfAborted()
    try {
      // Fresh files and a fresh TLS connection handle atomic projected credential changes.
      const ca = readFileSync(options.caFile ?? "/var/run/kubernetes/ca.crt")
      const token = readFileSync(options.tokenFile ?? "/var/run/kubernetes/token", "utf8").trim()
      if (!ca.length || !token || /\s/.test(token)) throw new CapacityUnavailable()
      const body = await new Promise<Buffer>((resolve, reject) => {
        let timer: NodeJS.Timeout
        const fail = () => reject(new CapacityUnavailable())
        const req = request(
          origin,
          {
            path,
            method: "GET",
            ca,
            agent: false,
            signal,
            headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          },
          (res) => {
            const chunks: Buffer[] = []
            let size = 0
            res.on("data", (chunk: Buffer) => {
              size += chunk.length
              if (size > 65_536) req.destroy(new CapacityUnavailable())
              else chunks.push(chunk)
            })
            res.on("error", fail)
            res.on("aborted", fail)
            res.on("end", () => {
              clearTimeout(timer)
              if (res.statusCode !== 200) fail()
              else resolve(Buffer.concat(chunks))
            })
          },
        )
        timer = setTimeout(() => req.destroy(new CapacityUnavailable()), 5_000)
        req.on("error", () => {
          clearTimeout(timer)
          fail()
        })
        req.end()
      })
      const pool = JSON.parse(body.toString("utf8"))
      if (
        pool?.apiVersion !== "ate.dev/v1" ||
        pool.kind !== "WorkerPool" ||
        pool.metadata?.name !== options.poolName ||
        pool.metadata?.namespace !== options.namespace
      ) {
        throw new CapacityUnavailable()
      }
      const spec = pool.spec?.replicas
      const total = pool.status?.replicas ?? 0
      const ready = pool.status?.readyReplicas ?? 0
      if (![spec, total, ready].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new CapacityUnavailable()
      }
      if (
        !pool.status?.sandboxClasses?.some(
          (entry: { name?: string; conditions?: { type?: string; status?: string }[] }) =>
            entry.name === "gvisor" &&
            entry.conditions?.some(
              (condition) => condition.type === "Resolved" && condition.status === "True",
            ),
        )
      ) {
        return 0
      }
      return Math.min(spec, total, ready)
    } catch {
      throw new CapacityUnavailable()
    }
  }
}
