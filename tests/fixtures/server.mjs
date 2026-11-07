// Synthetic test transport only. This service never contacts an upstream API.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer } from "node:https"
import { pathToFileURL } from "node:url"

export const BOT_TOKEN = "900001:fixture-only"
export const BOT = {
  id: 900001,
  is_bot: true,
  first_name: "Fixture Bot",
  username: "telegram_pi_fixture_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
}
export const MODEL_ID = "gpt-4o-mini"
export const PLACEHOLDER_KEY = "substrate-egress-placeholder"
export const INJECTED_KEY = "fixture-injected-openai-key"
export const TOOL_ARGUMENTS = {
  path: "fixture.txt",
  content: "fixture tool output\n",
}
export const FINAL_TEXT = "Fixture tool turn complete."
export const STORAGE_PROOF_ARGUMENTS = { command: "node /app/storage-proof.mjs", timeout: 30 }
// Fixed diagnostic for the packaged production image. The only live SQLite handle is read-only.
// Pi public history APIs run on a temporary SQLite-consistent backup, never the live database.
export const E2E_PROBE = String.raw`
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,access} from 'node:fs/promises';
import {join} from 'node:path';
import {backup,DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {request} from 'node:https';
const require=createRequire('/app/package.json');
const {BACKGROUND_CONTEXT:ctx}=await import(require.resolve('@earendil-works/chord/context'));
const {createModels}=await import(require.resolve('@earendil-works/pi-ai/models'));
const {Harness,ProviderDoc,ROOT_CONVERSATION_ID,createRegistry}=await import(require.resolve('@earendil-works/pi-durable'));
const {openNodeSqliteStorage}=await import(require.resolve('@earendil-works/pi-durable/storage/sqlite/node'));
const marker=process.argv[1];
assert.match(marker,/^[a-f0-9]{16}-[a-e]$/);
const workspace=await readFile('/data/workspace/e2e-topic.txt','utf8');
assert.equal(workspace,marker+'\n');
const absent=[];
for(const path of ['/var/run/telegram/token','/var/run/secrets/kubernetes.io/serviceaccount/token','/var/run/kubernetes/token']){
  await assert.rejects(access(path)); absent.push(path);
}
assert(!Object.keys(process.env).some(k=>/TELEGRAM.*TOKEN|DATABASE_URL|AWS_SECRET_ACCESS_KEY/.test(k)));
const live='/data/pi/session.sqlite';
const db=new DatabaseSync(live,{readOnly:true});
const dir=await mkdtemp('/tmp/e2e-proof-');
let harness;
try{
  const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
  const wal=await stat(live+'-wal');
  const [main,log]=await Promise.all([readFile(live),readFile(live+'-wal')]);
  const sentinel=Buffer.from('e2e-seed:'+marker);
  const copy=join(dir,'session.sqlite'); await backup(db,copy);
  harness=await Harness.open(await openNodeSqliteStorage(copy),{models:createModels(),registry:createRegistry(),readOnly:true},ctx);
  const root=await harness.conversation(ROOT_CONVERSATION_ID,ctx); assert(root);
  const provider=await harness.snapshot(ProviderDoc,root.id,ctx);
  const history=await root.entries({order:'ascending'},1000,undefined,ctx); assert(!history.next);
  const userEntries=history.items.filter(e=>e.model?.[0]?.role==='user').map(e=>({id:e.id,content:e.model[0].content}));
  // Use a valid, allowed TLS connection. A disallowed HTTP authority must receive a policy 403,
  // not merely fail DNS, certificate validation, or connection setup.
  async function probe(host){return new Promise((resolve,reject)=>{
    const req=request('https://development-api.telegram-pi-fixtures.svc/development/probe',
      {agent:false,headers:host?{host}:{}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});
    req.setTimeout(10000,()=>req.destroy(new Error('probe_timeout')));req.on('error',reject);req.end();
  });}
  const before=await probe(); assert.equal(before.status,200);assert.equal(JSON.parse(before.body).authorization,null);
  const denied=await probe('api.ate-system.svc');assert.equal(denied.status,403);assert.equal(denied.body,'egress denied');
  const after=await probe();assert.equal(after.status,200);assert.equal(JSON.parse(after.body).authorization,null);
  console.log(JSON.stringify({marker,integrity,walBytes:wal.size,workspace,
    mainContainsSentinel:main.includes(sentinel),walContainsSentinel:log.includes(sentinel),
    conversationId:String(root.id),providerSessionId:provider?.sessionId,userEntries,
    rawEntryIds:history.items.map(e=>e.id),network:{allowed:before.status,authorization:null,denied:denied.status,deniedBody:denied.body,after:after.status},absent}));
}finally{await harness?.close(ctx);db.close();await rm(dir,{recursive:true,force:true});}
`

export function e2eTools(text) {
  const match = /^e2e-(seed|verify):([a-f0-9]{16}-[a-e])$/.exec(text)
  if (!match) return undefined
  const command = `node --input-type=module -e '${E2E_PROBE.replaceAll("'", "'\\''")}' ${match[2]}`
  return [
    ...(match[1] === "seed"
      ? [{ name: "write", arguments: { path: "e2e-topic.txt", content: `${match[2]}\n` } }]
      : []),
    { name: "bash", arguments: { command, timeout: 60 } },
  ]
}

const MAX_BODY = 1024 * 1024
const MAX_CALLS = 2000
const HEADER_NAMES = new Set([
  "host",
  "authorization",
  "content-type",
  "user-agent",
  "session_id",
  "x-client-request-id",
  "x-session-id",
  "x-fixture-proof",
])

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status })
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function parameters(request, url) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY) fail(413, "Fixture request exceeds 1 MiB")
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text) return Object.fromEntries(url.searchParams)
  if (request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text))
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    fail(400, "Invalid JSON")
  }
  if (!object(value)) fail(400, "Expected a JSON object")
  return value
}

function headersForRecord(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      name === "authorization"
        ? [`Bearer ${PLACEHOLDER_KEY}`, `Bearer ${INJECTED_KEY}`].includes(value)
          ? value
          : "[redacted]"
        : HEADER_NAMES.has(name)
          ? value
          : "[not recorded]",
    ]),
  )
}

function integer(value, fallback, minimum, maximum) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail(400, "Invalid fixture integer parameter")
  }
  return number
}

function responseEvents(body) {
  if (
    body.model !== MODEL_ID ||
    body.stream !== true ||
    body.store !== false ||
    !Array.isArray(body.input) ||
    !body.input.every(object)
  ) {
    fail(400, "Expected gpt-4o-mini OpenAI Responses with stream:true and store:false")
  }
  const userIndex = body.input.findLastIndex((item) => item.role === "user")
  if (userIndex < 0) fail(400, "Expected a user message")
  const turn = body.input.slice(userIndex)
  const content = turn[0].content
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => part.text ?? "").join("")
        : ""
  const storageProof = text.startsWith("actor-storage-proof:")
  const scenario = e2eTools(text)
  const completed = turn.filter((item) => item.type === "function_call_output").length
  const selected = scenario?.[Math.min(completed, scenario.length - 1)]
  const toolName = selected?.name ?? (storageProof ? "bash" : "write")
  const toolArguments =
    selected?.arguments ?? (storageProof ? STORAGE_PROOF_ARGUMENTS : TOOL_ARGUMENTS)
  // Stable within one bounded tool turn, independent of other conversations.
  const suffix = `${userIndex}_${createHash("sha256").update(JSON.stringify(turn[0])).digest("hex").slice(0, 16)}`
  const step = scenario ? `_${Math.min(completed, scenario.length - 1)}` : ""
  const callId = `call_fixture_${suffix}${step}`
  const itemId = `fc_fixture_${suffix}${step}`
  const call = turn.findLast((item) => item.type === "function_call")
  const result = turn.findLast((item) => item.type === "function_call_output")
  if (call || result) {
    const previous = scenario?.[completed - 1]
    const previousId = scenario ? `call_fixture_${suffix}_${completed - 1}` : callId
    if (
      (scenario && (!previous || completed > scenario.length)) ||
      call?.call_id !== previousId ||
      call?.name !== (previous?.name ?? toolName) ||
      call?.arguments !== JSON.stringify(previous?.arguments ?? toolArguments) ||
      result?.call_id !== previousId ||
      typeof result?.output !== "string" ||
      !result.output
    ) {
      fail(400, "Expected the fixture tool call and its nonempty result")
    }
  } else if (
    !Array.isArray(body.tools) ||
    !body.tools.some((tool) => tool?.type === "function" && tool.name === toolName)
  ) {
    fail(400, "Expected the selected fixture tool")
  }
  let finalText = FINAL_TEXT
  const finished = scenario ? completed === scenario.length : Boolean(result)
  if ((storageProof || scenario) && finished) {
    let proof
    try {
      proof = JSON.parse(result.output.trim())
    } catch {
      fail(400, "Expected storage proof JSON")
    }
    if (
      proof.integrity !== "ok" ||
      typeof proof.walBytes !== "number" ||
      !Array.isArray(proof.userEntries)
    ) {
      fail(400, "Invalid storage proof result")
    }
    finalText = JSON.stringify(proof)
  }
  const id = `resp_fixture_${suffix}${step}_${finished ? "final" : "tool"}`
  const response = {
    id,
    object: "response",
    created_at: 1,
    model: MODEL_ID,
    status: "in_progress",
    output: [],
    error: null,
    incomplete_details: null,
  }
  const events = []
  const emit = (type, fields) => events.push({ type, sequence_number: events.length, ...fields })
  emit("response.created", { response })
  let output
  if (!finished) {
    output = {
      type: "function_call",
      id: itemId,
      call_id: callId,
      name: toolName,
      arguments: "",
      status: "in_progress",
    }
    emit("response.output_item.added", { output_index: 0, item: output })
    const args = JSON.stringify(toolArguments)
    const midpoint = Math.floor(args.length / 2)
    for (const delta of [args.slice(0, midpoint), args.slice(midpoint)]) {
      emit("response.function_call_arguments.delta", { output_index: 0, item_id: itemId, delta })
    }
    emit("response.function_call_arguments.done", {
      output_index: 0,
      item_id: itemId,
      arguments: args,
    })
    output = { ...output, arguments: args, status: "completed" }
  } else {
    const messageId = `msg_fixture_${suffix}`
    output = {
      type: "message",
      id: messageId,
      role: "assistant",
      status: "in_progress",
      content: [],
    }
    emit("response.output_item.added", { output_index: 0, item: output })
    const part = { type: "output_text", text: "", annotations: [], logprobs: [] }
    emit("response.content_part.added", {
      output_index: 0,
      item_id: messageId,
      content_index: 0,
      part,
    })
    const midpoint = Math.floor(finalText.length / 2)
    for (const delta of [finalText.slice(0, midpoint), finalText.slice(midpoint)]) {
      emit("response.output_text.delta", {
        output_index: 0,
        item_id: messageId,
        content_index: 0,
        delta,
        logprobs: [],
      })
    }
    emit("response.output_text.done", {
      output_index: 0,
      item_id: messageId,
      content_index: 0,
      text: finalText,
      logprobs: [],
    })
    const finalPart = { ...part, text: finalText }
    emit("response.content_part.done", {
      output_index: 0,
      item_id: messageId,
      content_index: 0,
      part: finalPart,
    })
    output = { ...output, status: "completed", content: [finalPart] }
  }
  emit("response.output_item.done", { output_index: 0, item: output })
  emit("response.completed", {
    response: {
      ...response,
      status: "completed",
      output: [output],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  })
  return events
}

export function createFixture(tls) {
  let updates = []
  let sent = []
  let calls = []
  let nextMessageId = 1
  let acknowledgedOffset = 0
  let appended = new Map()
  return createServer({ ...tls, minVersion: "TLSv1.2" }, async (request, response) => {
    let record
    try {
      const url = new URL(request.url, "https://fixture.invalid")
      if (url.pathname === "/healthz" && request.method === "GET") {
        return json(response, 200, { ok: true })
      }
      if (url.pathname === "/__fixture/state" && request.method === "GET") {
        return json(response, 200, { calls, sent, updates, acknowledgedOffset })
      }
      const body = await parameters(request, url)
      if (url.pathname === "/__fixture/append" && request.method === "POST") {
        if (
          !Array.isArray(body.updates) ||
          body.updates.length < 1 ||
          body.updates.length > 100 ||
          body.updates.some(
            (update) =>
              !object(update) ||
              !Number.isSafeInteger(update.update_id) ||
              update.update_id < acknowledgedOffset,
          )
        )
          fail(400, "Append requires 1 to 100 updates at or above the acknowledged offset")
        const candidate = new Map(appended)
        const added = []
        for (const update of body.updates) {
          const existing = candidate.get(update.update_id)
          if (existing && JSON.stringify(existing) !== JSON.stringify(update))
            fail(409, "Update ID conflict")
          if (!existing) {
            candidate.set(update.update_id, update)
            added.push(update)
          }
        }
        if (updates.length + added.length > 100 || candidate.size > 2000)
          fail(507, "Fixture update limit reached")
        appended = candidate
        updates = [...updates, ...added].sort((a, b) => a.update_id - b.update_id)
        return json(response, 200, { ok: true, added: added.length })
      }
      if (url.pathname === "/__fixture/reset" && request.method === "POST") {
        if (
          !Array.isArray(body.updates) ||
          body.updates.length > 100 ||
          body.updates.some(
            (update) =>
              !object(update) || !Number.isSafeInteger(update.update_id) || update.update_id < 0,
          )
        ) {
          fail(400, "Reset requires at most 100 synthetic updates with nonnegative update_id")
        }
        updates = [...body.updates].sort((a, b) => a.update_id - b.update_id)
        sent = []
        calls = []
        nextMessageId = 1
        acknowledgedOffset = 0
        appended = new Map(updates.map((update) => [update.update_id, update]))
        return json(response, 200, { ok: true })
      }
      if (calls.length >= MAX_CALLS)
        fail(507, "Fixture call limit reached; reset before the next test")
      const telegram = url.pathname.match(/^\/bot([^/]+)\/([a-zA-Z]+)$/)
      record = {
        sequence: calls.length + 1,
        at: new Date().toISOString(),
        method: request.method,
        path: telegram ? `/bot[redacted]/${telegram[2]}` : url.pathname,
        headers: headersForRecord(request.headers),
        body,
        tls: { servername: request.socket.servername, protocol: request.socket.getProtocol() },
      }
      calls.push(record)
      if (telegram) {
        if (telegram[1] !== BOT_TOKEN) fail(401, "Synthetic Bot token required")
        if (!["GET", "POST"].includes(request.method)) fail(405, "Use GET or POST")
        let result
        switch (telegram[2]) {
          case "getMe":
            result = BOT
            break
          case "getWebhookInfo":
            result = {
              url: "",
              has_custom_certificate: false,
              pending_update_count: updates.length,
            }
            break
          case "getUpdates": {
            const offset = integer(body.offset, 0, 0, Number.MAX_SAFE_INTEGER)
            const limit = integer(body.limit, 100, 1, 100)
            acknowledgedOffset = Math.max(acknowledgedOffset, offset)
            updates = updates.filter((update) => update.update_id >= offset)
            result = updates.slice(0, limit)
            if (!result.length && Number(body.timeout) > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(Number(body.timeout) * 1000, 1000)),
              )
            }
            break
          }
          case "sendMessage": {
            const chatId = integer(
              body.chat_id,
              undefined,
              Number.MIN_SAFE_INTEGER,
              Number.MAX_SAFE_INTEGER,
            )
            if (typeof body.text !== "string" || !body.text || [...body.text].length > 4096)
              fail(400, "Expected 1 to 4096 text characters")
            result = {
              message_id: nextMessageId++,
              date: 1,
              from: BOT,
              chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
              text: body.text,
            }
            if (body.message_thread_id !== undefined)
              result.message_thread_id = integer(
                body.message_thread_id,
                undefined,
                1,
                Number.MAX_SAFE_INTEGER,
              )
            sent.push(result)
            break
          }
          default:
            fail(404, "Unsupported synthetic Telegram method")
        }
        record.status = 200
        return json(response, 200, { ok: true, result })
      }
      if (url.pathname === "/development/probe" && request.method === "GET") {
        record.status = 200
        return json(response, 200, {
          ok: true,
          authorization: headersForRecord(request.headers).authorization ?? null,
        })
      }
      if (url.pathname === "/openai/v1/responses" && request.method === "POST") {
        if (
          ![PLACEHOLDER_KEY, INJECTED_KEY].some(
            (key) => request.headers.authorization === `Bearer ${key}`,
          )
        )
          fail(401, "Synthetic model key required")
        const events = responseEvents(body)
        record.status = 200
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        })
        for (const event of events) {
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          await new Promise((resolve) => setImmediate(resolve))
        }
        return response.end()
      }
      fail(404, "Unsupported fixture route")
    } catch (error) {
      const status = error.status ?? 500
      if (record) record.status = status
      if (!response.headersSent)
        json(response, status, {
          ok: false,
          error_code: status,
          description: status === 500 ? "Fixture internal error" : error.message,
        })
      else response.destroy()
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bundle = readFileSync(process.argv[2])
  const server = createFixture({ key: bundle, cert: bundle })
  server.listen(8443, "0.0.0.0", () => console.log("Synthetic HTTPS fixture listening on 8443"))
  process.on("SIGTERM", () => server.close(() => process.exit(0)))
}
