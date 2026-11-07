import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { LIMITS } from "./config.js"
import { ActorError, type ActorRuntime } from "./runtime.js"

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new ActorError(415, "json_required")
  const declared = Number(request.headers["content-length"] ?? 0)
  if (!Number.isFinite(declared) || declared > LIMITS.requestBytes)
    throw new ActorError(413, "body_too_large")
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk)
    if (length > LIMITS.requestBytes) throw new ActorError(413, "body_too_large")
    chunks.push(Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new ActorError(400, "invalid_json")
  }
}
function send(response: ServerResponse, status: number, value: unknown) {
  if (response.writableEnded || response.destroyed) return
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > LIMITS.responseBytes) {
    response.writeHead(503, { "content-type": "application/json" })
    response.end('{"error":"response_too_large"}')
    return
  }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  response.end(json)
}

export function actorServer(runtime: ActorRuntime) {
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    // This bounds the HTTP wait only. Never pass the socket's cancellation to durable work.
    const timer = setTimeout(() => {
      send(response, 503, { error: "http_timeout", reattach: true })
      if (!request.complete) request.destroy()
    }, LIMITS.httpTimeoutMs)
    response.once("close", () => clearTimeout(timer))
    void (async () => {
      const url = new URL(request.url ?? "/", "http://actor")
      if (url.href.length > 1024) throw new ActorError(414, "uri_too_long")
      if (request.method === "GET" && ["/healthz", "/warmup", "/wakeup"].includes(url.pathname)) {
        send(response, 200, { ready: true })
      } else if (request.method === "POST" && url.pathname === "/v1/submissions") {
        const input = await body(request)
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new ActorError(400, "invalid_submission")
        const record = input as Record<string, unknown>
        if (Object.keys(record).some((key) => key !== "requestId" && key !== "text"))
          throw new ActorError(400, "invalid_submission")
        send(response, 202, await runtime.submit(record.requestId as string, record.text as string))
      } else if (request.method === "GET" && url.pathname === "/v1/submissions") {
        send(response, 200, await runtime.status(url.searchParams.get("requestId") ?? ""))
      } else if (request.method === "GET" && url.pathname === "/v1/quiescence") {
        send(response, 200, await runtime.quiescence())
      } else throw new ActorError(404, "not_found")
    })().catch((error: unknown) => {
      send(response, error instanceof ActorError ? error.status : 503, {
        error: error instanceof ActorError ? error.code : "actor_unavailable",
      })
    })
  })
  server.requestTimeout = LIMITS.httpTimeoutMs
  server.headersTimeout = LIMITS.httpTimeoutMs
  server.keepAliveTimeout = 1000
  server.maxRequestsPerSocket = 100
  return server
}
