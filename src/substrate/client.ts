import { readFileSync } from "node:fs"
import type { IncomingHttpHeaders } from "node:http"
import { Agent, request } from "node:https"
import { credentials, Metadata } from "@grpc/grpc-js"
import { ControlClient, ControlService } from "./generated/ateapi/v1/ateapi.js"

type Method = keyof typeof ControlService
type Input<M extends Method> = Parameters<(typeof ControlService)[M]["requestSerialize"]>[0]
type Output<M extends Method> = ReturnType<(typeof ControlService)[M]["responseDeserialize"]>

export interface SubstrateOptions {
  caFile: string
  api: {
    address?: string
    serverName?: string
    // Select one principal. Sending a certificate would override a bearer token.
    auth: { kind: "bearer"; tokenFile: string } | { kind: "mtls"; bundleFile: string }
  }
  // Omit this on the provisioner. Only the Gateway needs Router ingress.
  router?: { origin: string; bundleFile: string }
}

export interface WaitOptions {
  timeoutMs?: number
  // Aborting detaches this wait. It does not cancel or replay durable Actor work.
  signal?: AbortSignal
}

export interface ActorResponse {
  statusCode: number
  headers: IncomingHttpHeaders
  body: Buffer
}

interface Generation<T> {
  ca: Buffer
  bundle?: Buffer
  transport: T
  active: number
  retired: boolean
  dispose: () => void
}

function dnsLabel(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 63 &&
    !/[^a-z0-9-]/.test(value) &&
    !value.startsWith("-") &&
    !value.endsWith("-")
  )
}

function timeout(options: WaitOptions): number {
  const value = options.timeoutMs ?? 30_000
  if (!Number.isInteger(value) || value < 1 || value > 300_000) {
    throw new Error("timeoutMs must be an integer from 1 to 300000")
  }
  options.signal?.throwIfAborted()
  return value
}

function wait<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/**
 * One instance per workload identity. API editor is atespace-wide, not per-Actor
 * or per-verb. Provisioner and Gateway must use distinct ServiceAccounts/grants.
 * The Router SPIFFE allowlist is NOT application conversation authorization.
 * Credentials are read by pathname on each operation, including atomic projected
 * volume replacements. Rotate CA trust with overlap before changing leaves.
 */
export class SubstrateClient {
  private readonly options: SubstrateOptions
  private readonly origin?: URL
  private api?: Generation<ControlClient>
  private router?: Generation<Agent>
  private readonly generations = new Set<Generation<ControlClient | Agent>>()
  private closed = false
  private closing?: Promise<void>
  private drained?: () => void

  constructor(options: SubstrateOptions) {
    this.options = structuredClone(options)
    if (options.router) {
      const url = new URL(options.router.origin)
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        throw new Error(
          "Router origin must be a trusted HTTPS origin without a path or credentials",
        )
      }
      this.origin = url
    }
  }

  private acquire<T extends ControlClient | Agent>(
    previous: Generation<T> | undefined,
    bundleFile: string | undefined,
    create: (ca: Buffer, bundle?: Buffer) => T,
  ): Generation<T> {
    if (this.closed) throw new Error("Substrate client is closed")
    const ca = readFileSync(this.options.caFile)
    const bundle = bundleFile ? readFileSync(bundleFile) : undefined
    if (!ca.length || bundle?.length === 0) throw new Error("TLS credential file is empty")
    if (
      previous &&
      ca.equals(previous.ca) &&
      (bundle ? previous.bundle?.equals(bundle) : previous.bundle === undefined)
    ) {
      previous.active++
      return previous
    }
    const transport = create(ca, bundle)
    const next: Generation<T> = {
      ca,
      bundle,
      transport,
      active: 1,
      retired: false,
      dispose: () => {
        if (transport instanceof Agent) transport.destroy()
        else transport.close()
      },
    }
    this.generations.add(next)
    if (previous) this.retire(previous)
    return next
  }

  private retire(generation: Generation<ControlClient | Agent>) {
    generation.retired = true
    if (generation.active === 0) {
      generation.dispose()
      this.generations.delete(generation)
      if (this.closed && this.generations.size === 0) this.drained?.()
    }
  }

  private release(generation: Generation<ControlClient | Agent>) {
    generation.active--
    if (generation.retired) this.retire(generation)
  }

  async rpc<M extends Method>(
    method: M,
    input: Input<M>,
    options: WaitOptions = {},
  ): Promise<Output<M>> {
    const duration = timeout(options)
    const auth = this.options.api.auth
    const metadata = new Metadata()
    if (auth.kind === "bearer") {
      const token = readFileSync(auth.tokenFile, "utf8").trim()
      if (!token || /\s/.test(token))
        throw new Error("API bearer token is empty or contains whitespace")
      metadata.set("authorization", `Bearer ${token}`)
    }
    const generation = this.acquire(
      this.api,
      auth.kind === "mtls" ? auth.bundleFile : undefined,
      (ca, bundle) =>
        new ControlClient(
          this.options.api.address ?? "dns:///api.ate-system.svc:443",
          credentials.createSsl(ca, bundle, bundle),
          {
            "grpc.ssl_target_name_override": this.options.api.serverName ?? "api.ate-system.svc",
            "grpc.default_authority": this.options.api.serverName ?? "api.ate-system.svc",
            "grpc.enable_retries": 0,
            "grpc.service_config": JSON.stringify({ loadBalancingConfig: [{ round_robin: {} }] }),
          },
        ),
    )
    this.api = generation
    const definition = ControlService[method]
    const pending = new Promise<Output<M>>((resolve, reject) => {
      try {
        generation.transport.makeUnaryRequest(
          definition.path,
          definition.requestSerialize as (value: Input<M>) => Buffer,
          definition.responseDeserialize as (value: Buffer) => Output<M>,
          input,
          metadata,
          { deadline: Date.now() + duration },
          (error, response) => {
            this.release(generation)
            if (error) reject(error)
            else resolve(response as Output<M>)
          },
        )
      } catch (error) {
        this.release(generation)
        reject(error)
      }
    })
    return wait(pending, options.signal)
  }

  async actor(
    target: { atespace: string; name: string },
    input: { method: "GET" | "POST"; path: string; body?: string },
    options: WaitOptions = {},
  ): Promise<ActorResponse> {
    const duration = timeout(options)
    if (!this.origin || !this.options.router) throw new Error("Router is not configured")
    if (!dnsLabel(target.atespace) || !dnsLabel(target.name)) {
      throw new Error("Actor atespace and name must be DNS labels of at most 63 characters")
    }
    // Never accept an absolute URL, authority, fragment, or backslash from Actor input.
    if (!input.path.startsWith("/") || /^\/\//.test(input.path) || /[\\#\r\n]/.test(input.path)) {
      throw new Error("Actor path must be an origin-relative path")
    }
    const generation = this.acquire(
      this.router,
      this.options.router.bundleFile,
      (ca, bundle) =>
        new Agent({ ca, key: bundle, cert: bundle, keepAlive: true, maxCachedSessions: 0 }),
    )
    this.router = generation
    const pending = new Promise<ActorResponse>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      let released = false
      const release = () => {
        clearTimeout(timer)
        if (!released) this.release(generation)
        released = true
      }
      try {
        const req = request(
          this.origin as URL,
          {
            agent: generation.transport,
            method: input.method,
            path: input.path,
            headers: {
              "ate-target-actor": `${target.atespace}/${target.name}`,
              ...(input.body === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(input.body),
                  }),
            },
          },
          (res) => {
            const chunks: Buffer[] = []
            let size = 0
            res.on("data", (chunk: Buffer) => {
              size += chunk.length
              if (size > 1_048_576) req.destroy(new Error("Actor response exceeds 1 MiB"))
              else chunks.push(chunk)
            })
            res.on("error", reject)
            res.on("end", () =>
              resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks),
              }),
            )
          },
        )
        timer = setTimeout(
          () => req.destroy(new Error("Actor request deadline exceeded")),
          duration,
        )
        req.on("error", reject)
        req.on("close", release)
        req.end(input.body)
      } catch (error) {
        release()
        reject(error)
      }
    })
    // Native HTTPS does not follow redirects. No retry may replay an Actor effect.
    return wait(pending, options.signal)
  }

  /** Stop admission, then retire connections after bounded calls finish. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = new Promise((resolve) => {
      this.drained = resolve
      for (const generation of this.generations) this.retire(generation)
      if (this.generations.size === 0) resolve()
    })
    return this.closing
  }
}
