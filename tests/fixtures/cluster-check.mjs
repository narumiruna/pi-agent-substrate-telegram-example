// In-cluster TLS/protocol probe only. The production Pi adapter is checked in check.mjs.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { request } from "node:https"
import { BOT, BOT_TOKEN, FINAL_TEXT, MODEL_ID, PLACEHOLDER_KEY, TOOL_ARGUMENTS } from "./server.mjs"

const origin = "https://synthetic-api.telegram-pi-fixtures.svc"
const ca = readFileSync("/run/servicedns.podcert.ate.dev/trust-bundle.pem")

function call(path, body, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      `${origin}${path}`,
      {
        ca,
        agent: false,
        timeout: 5000,
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${PLACEHOLDER_KEY}`,
          "x-fixture-proof": "direct-cluster-probe",
        },
        ...options,
      },
      (response) => {
        const chunks = []
        response.on("data", (chunk) => chunks.push(chunk))
        response.on("end", () =>
          resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }),
        )
        response.on("error", reject)
      },
    )
    req.on("error", reject)
    req.on("timeout", () => req.destroy(new Error("Fixture probe timed out")))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

// A Deployment can become Ready before Service routing converges. Only retry
// transport setup for this read-only readiness request, never a model/tool turn.
for (let attempt = 0; ; attempt++) {
  try {
    assert.equal((await call("/healthz")).status, 200)
    break
  } catch (error) {
    if (attempt >= 9 || !["ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"].includes(error.code))
      throw error
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
await assert.rejects(call("/healthz", undefined, { ca: undefined }), (error) =>
  [
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  ].includes(error.code),
)
await assert.rejects(call("/healthz", undefined, { servername: "wrong.fixture.invalid" }), {
  code: "ERR_TLS_CERT_ALTNAME_INVALID",
})
assert.equal((await call("/healthz")).status, 200)
const me = await call(`/bot${BOT_TOKEN}/getMe`)
assert.equal(me.status, 200)
assert.deepEqual(JSON.parse(me.text).result, BOT)
const webhook = await call(`/bot${BOT_TOKEN}/getWebhookInfo`)
assert.equal(JSON.parse(webhook.text).result.url, "")

const body = {
  model: MODEL_ID,
  stream: true,
  store: false,
  input: [{ role: "user", content: [{ type: "input_text", text: "Synthetic cluster probe" }] }],
  tools: [{ type: "function", name: "write", parameters: { type: "object" } }],
}
function events(response) {
  assert.equal(response.status, 200, response.text)
  return response.text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
}
const first = events(await call("/openai/v1/responses", body))
const tool = first.find((event) => event.type === "response.output_item.done").item
assert.equal(tool.name, "write")
assert.deepEqual(JSON.parse(tool.arguments), TOOL_ARGUMENTS)
const final = events(
  await call("/openai/v1/responses", {
    ...body,
    input: [
      ...body.input,
      tool,
      {
        type: "function_call_output",
        call_id: tool.call_id,
        output: "Synthetic protocol result; no Actor tool ran",
      },
    ],
  }),
)
assert.equal(final.at(-1).type, "response.completed")
assert.equal(final.at(-1).response.output[0].content[0].text, FINAL_TEXT)
console.log(
  "PASS: cluster service DNS, trusted HTTPS, negative TLS checks, Telegram identity, and bounded Responses SSE protocol",
)
console.log("Not checked: Actor execution, egress routing, credential injection, or task 12")
