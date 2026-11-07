// Focused transport checks. Run with node --test tests/fixtures/check.mjs.
// No Actor, Gateway, sandbox, credential-injection, or task-12 acceptance claim.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { request } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, beforeEach, test } from "node:test"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { createModels } from "@earendil-works/pi-ai/models"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import {
  BOT,
  BOT_TOKEN,
  createFixture,
  E2E_PROBE,
  e2eTools,
  FINAL_TEXT,
  INJECTED_KEY,
  MODEL_ID,
  PLACEHOLDER_KEY,
  STORAGE_PROOF_ARGUMENTS,
  TOOL_ARGUMENTS,
} from "./server.mjs"

const directory = mkdtempSync(join(tmpdir(), "telegram-pi-fixture-"))
const keyPath = join(directory, "key.pem")
const certPath = join(directory, "cert.pem")
const roots = getCACertificates("default")
let server
let baseUrl
let cert

before(async () => {
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  )
  assert.equal(generated.status, 0, "OpenSSL must generate an ephemeral test-only certificate")
  cert = readFileSync(certPath, "utf8")
  server = createFixture({ key: readFileSync(keyPath), cert })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  baseUrl = `https://localhost:${server.address().port}`
  // Only this test process gains the ephemeral CA. No TLS verification bypass.
  setDefaultCACertificates([...roots, cert])
})

after(async () => {
  setDefaultCACertificates(roots)
  if (server) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  rmSync(directory, { recursive: true, force: true })
})

async function api(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(5000),
  })
  return { status: response.status, data: await response.json() }
}

beforeEach(async () => {
  assert.equal((await api("/__fixture/reset", { updates: [] })).status, 200)
})

test("HTTPS requires the origin root and the correct DNS SAN", async () => {
  async function probe(options) {
    return new Promise((resolve, reject) => {
      const req = request(baseUrl, { agent: false, ...options }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on("error", reject)
      req.end()
    })
  }
  await assert.rejects(probe({ ca: roots }))
  await assert.rejects(probe({ ca: cert, servername: "wrong.fixture.invalid" }), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
  })
  assert.equal(await probe({ ca: cert, path: "/healthz" }), 200)
})

test("Telegram identity, webhook status, duplicate polls, offset acknowledgement, and topic delivery", async () => {
  const updates = [
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1,
        from: { id: 101, is_bot: false, first_name: "Fixture" },
        chat: { id: 201, type: "private" },
        text: "Synthetic tool request",
      },
    },
    {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1,
        from: { id: 102, is_bot: false, first_name: "Fixture" },
        chat: { id: -202, type: "supergroup" },
        message_thread_id: 7,
        text: "@telegram_pi_fixture_bot synthetic topic request",
      },
    },
  ]
  await api("/__fixture/reset", { updates })
  const prefix = `/bot${BOT_TOKEN}/`
  assert.deepEqual((await api(`${prefix}getMe`)).data.result, BOT)
  assert.deepEqual((await api(`${prefix}getWebhookInfo`, {})).data.result, {
    url: "",
    has_custom_certificate: false,
    pending_update_count: 2,
  })
  assert.deepEqual((await api(`${prefix}getUpdates`, { offset: 0 })).data.result, updates)
  assert.deepEqual((await api(`${prefix}getUpdates?offset=0`)).data.result, updates)
  assert.deepEqual((await api(`${prefix}getUpdates`, { offset: 2, limit: 1 })).data.result, [
    updates[1],
  ])
  assert.deepEqual((await api(`${prefix}getUpdates`, { offset: 0 })).data.result, [updates[1]])
  assert.deepEqual((await api(`${prefix}getUpdates`, { offset: 3 })).data.result, [])
  const sent = await api(`${prefix}sendMessage`, {
    chat_id: -202,
    message_thread_id: 7,
    text: "Synthetic reply 🧪",
  })
  assert.equal(sent.status, 200)
  assert.equal(sent.data.result.message_id, 1)
  assert.equal(sent.data.result.chat.id, -202)
  assert.equal(sent.data.result.message_thread_id, 7)
  assert.equal((await api("/__fixture/state")).data.sent.length, 1)
})

test("installed production OpenAI provider streams one write call and its final answer", async () => {
  const models = createModels()
  models.setProvider(openaiProvider())
  const catalog = models.getModel("openai", MODEL_ID)
  assert.ok(catalog)
  assert.equal(catalog.api, "openai-responses")
  assert.equal(catalog.reasoning, false)
  assert.deepEqual(catalog.compat, { supportsStrictMode: true })
  const model = { ...catalog, baseUrl: `${baseUrl}/openai/v1` }
  const context = {
    messages: [{ role: "user", content: "Synthetic tool request", timestamp: 1 }],
    tools: [
      {
        name: "write",
        description: "Synthetic write tool",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    ],
  }
  const options = {
    apiKey: PLACEHOLDER_KEY,
    sessionId: "fixture-session-1",
    maxTokens: 128,
    maxRetries: 0,
    signal: AbortSignal.timeout(5000),
  }
  const stream = models.stream(model, context, options)
  const eventTypes = []
  for await (const event of stream) eventTypes.push(event.type)
  const first = await stream.result()
  assert.equal(first.stopReason, "toolUse", first.errorMessage)
  assert.deepEqual(eventTypes, [
    "start",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_delta",
    "toolcall_end",
    "done",
  ])
  const call = first.content[0]
  assert.equal(call.type, "toolCall")
  assert.equal(call.name, "write")
  assert.match(call.id, /^call_fixture_.*\|fc_fixture_/)
  assert.deepEqual(call.arguments, TOOL_ARGUMENTS)
  // This is a protocol result, not proof of Actor tool execution.
  context.messages.push(first, {
    role: "toolResult",
    toolCallId: call.id,
    toolName: "write",
    content: [{ type: "text", text: "Successfully wrote to fixture.txt" }],
    isError: false,
    timestamp: 2,
  })
  const finalStream = models.stream(model, context, { ...options, apiKey: INJECTED_KEY })
  const finalEvents = []
  for await (const event of finalStream) finalEvents.push(event.type)
  const final = await finalStream.result()
  assert.equal(final.stopReason, "stop", final.errorMessage)
  assert.equal(final.content[0].text, FINAL_TEXT)
  assert.deepEqual(finalEvents, [
    "start",
    "text_start",
    "text_delta",
    "text_delta",
    "text_end",
    "done",
  ])
  assert.equal(final.usage.totalTokens, 15)
  const {
    data: { calls },
  } = await api("/__fixture/state")
  assert.equal(calls.length, 2)
  assert.equal(calls[0].path, "/openai/v1/responses")
  assert.equal(calls[0].headers.authorization, `Bearer ${PLACEHOLDER_KEY}`)
  assert.equal(calls[1].headers.authorization, `Bearer ${INJECTED_KEY}`)
  assert.equal(calls[0].headers.session_id, "fixture-session-1")
  assert.equal(calls[0].body.prompt_cache_key, "fixture-session-1")
  assert.equal(calls[0].body.store, false)
  assert.equal(calls[0].body.tools[0].type, "function")
  assert.equal(calls[0].tls.servername, "localhost")
  assert.ok(
    calls[1].body.input.some(
      (item) => item.type === "function_call_output" && item.call_id === call.id.split("|")[0],
    ),
  )
})

test("storage proof uses one fixed command and returns the tool JSON", async () => {
  const models = createModels()
  models.setProvider(openaiProvider())
  const model = { ...models.getModel("openai", MODEL_ID), baseUrl: `${baseUrl}/openai/v1` }
  const context = {
    messages: [{ role: "user", content: "actor-storage-proof:unit-only", timestamp: 1 }],
    tools: [
      {
        name: "bash",
        description: "Synthetic diagnostic command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" }, timeout: { type: "number" } },
          required: ["command", "timeout"],
          additionalProperties: false,
        },
      },
    ],
  }
  const options = {
    apiKey: INJECTED_KEY,
    maxTokens: 1024,
    maxRetries: 0,
    signal: AbortSignal.timeout(5000),
  }
  const first = await models.complete(model, context, options)
  assert.equal(first.stopReason, "toolUse", first.errorMessage)
  const call = first.content[0]
  assert.equal(call.name, "bash")
  assert.deepEqual(call.arguments, STORAGE_PROOF_ARGUMENTS)
  const proof = {
    integrity: "ok",
    walBytes: 8192,
    workspace: "fixture tool output\n",
    userEntries: [{ id: 1, content: "previous input" }],
  }
  context.messages.push(first, {
    role: "toolResult",
    toolCallId: call.id,
    toolName: "bash",
    content: [{ type: "text", text: JSON.stringify(proof) }],
    isError: false,
    timestamp: 2,
  })
  const final = await models.complete(model, context, options)
  assert.equal(final.stopReason, "stop", final.errorMessage)
  assert.deepEqual(JSON.parse(final.content[0].text), proof)
})

test("append retains calls and pending updates and refuses ID conflicts atomically", async () => {
  await api(`/bot${BOT_TOKEN}/getMe`, {})
  const update = { update_id: 50, message: { text: "owned fixture update" } }
  assert.equal((await api("/__fixture/append", { updates: [update] })).data.added, 1)
  assert.equal((await api("/__fixture/append", { updates: [update] })).data.added, 0)
  assert.equal(
    (
      await api("/__fixture/append", {
        updates: [{ update_id: 51 }, { update_id: 50, message: {} }],
      })
    ).status,
    409,
  )
  let state = (await api("/__fixture/state")).data
  assert.equal(state.calls.length, 1)
  assert.deepEqual(state.updates, [update])
  await api(`/bot${BOT_TOKEN}/getUpdates`, { offset: 51 })
  assert.equal((await api("/__fixture/append", { updates: [update] })).status, 400)
  assert.equal((await api("/__fixture/append", { updates: [{ update_id: 52 }] })).status, 200)
  state = (await api("/__fixture/state")).data
  assert.equal(state.calls.length, 2)
  assert.equal(state.acknowledgedOffset, 51)
  assert.deepEqual(state.updates, [{ update_id: 52 }])
})

test("inline proof dependencies resolve with ESM import conditions from the application directory", () => {
  const imports = E2E_PROBE.split("const marker=")[0]
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", imports], {
    encoding: "utf8",
    timeout: 300_000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(e2eTools("e2e-seed:0123456789abcdef-a")[1].arguments.command, /^cd \/app && node /)
})

test("explicit TLS SNI stays valid when the HTTP destination authority changes", async () => {
  const response = await new Promise((resolve, reject) => {
    const req = request(
      `${baseUrl}/development/probe`,
      { ca: cert, agent: false, servername: "localhost", headers: { host: "api.ate-system.svc" } },
      (res) => {
        res.resume()
        res.on("end", () => resolve(res.statusCode))
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(response, 200)
  const record = (await api("/__fixture/state")).data.calls.at(-1)
  assert.equal(record.headers.host, "api.ate-system.svc")
  assert.equal(record.tls.servername, "localhost")
  assert(E2E_PROBE.includes("servername:'development-api.telegram-pi-fixtures.svc'"))
})

test("packaged E2E scenario streams fixed write, inline read-only proof, and final JSON", async () => {
  const marker = "0123456789abcdef-a"
  const text = `e2e-seed:${marker}`
  const tools = e2eTools(text)
  assert.equal(tools.length, 2)
  assert.deepEqual(tools[0], {
    name: "write",
    arguments: { path: "e2e-topic.txt", content: `${marker}\n` },
  })
  assert.match(tools[1].arguments.command, /readOnly:true/)
  assert.equal(e2eTools("e2e-seed:arbitrary-shell;"), undefined)
  const models = createModels()
  models.setProvider(openaiProvider())
  const model = { ...models.getModel("openai", MODEL_ID), baseUrl: `${baseUrl}/openai/v1` }
  const context = {
    messages: [{ role: "user", content: text, timestamp: 1 }],
    tools: tools.map((t) => ({
      name: t.name,
      description: "Fixed test tool",
      parameters: { type: "object", properties: {} },
    })),
  }
  const proof = { integrity: "ok", walBytes: 100, userEntries: [{ id: 1, content: text }] }
  for (const [index, expected] of tools.entries()) {
    const response = await models.complete(model, context, {
      apiKey: INJECTED_KEY,
      maxRetries: 0,
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.stopReason, "toolUse", response.errorMessage)
    const call = response.content[0]
    assert.equal(call.name, expected.name)
    assert.deepEqual(call.arguments, expected.arguments)
    context.messages.push(response, {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: index === 0 ? "Written" : JSON.stringify(proof) }],
      isError: false,
      timestamp: index + 2,
    })
  }
  const result = await models.complete(model, context, {
    apiKey: INJECTED_KEY,
    maxRetries: 0,
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(result.stopReason, "stop", result.errorMessage)
  assert.deepEqual(JSON.parse(result.content[0].text), proof)
})

test("unknown routes, credentials, and malformed model protocols fail without credential records", async () => {
  assert.equal((await api("/botnot-a-fixture-value/getMe")).status, 401)
  const response = await fetch(`${baseUrl}/openai/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer not-a-fixture-value", "content-type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(response.status, 401)
  await response.text()
  assert.equal((await api("/openai/v1/chat/completions", {})).status, 404)
  const badProtocol = await fetch(`${baseUrl}/openai/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${PLACEHOLDER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "unknown", stream: true }),
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(badProtocol.status, 400)
  await badProtocol.text()
  const { data } = await api("/__fixture/state")
  assert.equal(data.calls[0].path, "/bot[redacted]/getMe")
  assert.equal(data.calls[1].headers.authorization, "[redacted]")
  assert.ok(!JSON.stringify(data).includes("not-a-fixture-value"))
})
