import { execFileSync } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import {
  defineExtension,
  defineTask,
  hook,
  ProviderDoc,
  ToolResultEntry,
  ToolTask,
} from "@earendil-works/pi-durable"
import { FileError } from "@earendil-works/pi-durable/env"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { describe, expect, it, vi } from "vitest"
import { LIMITS, openAIModels, PLACEHOLDER_KEY } from "../src/actor/config.js"
import { ActorRuntime } from "../src/actor/runtime.js"
import { call, context, eventually, fixture, requestId, session, settled } from "./actor/helpers.js"

function integrity(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare("PRAGMA integrity_check").get()
  } finally {
    db.close()
  }
}

describe("Pi Durable Actor", () => {
  it("runs all four CodingTools in the workspace and preserves one root and live WAL", async () => {
    const f = await fixture([
      call("write", { path: "notes.txt", content: "hello world\n" }),
      call("read", { path: "notes.txt" }),
      call("edit", { path: "notes.txt", edits: [{ oldText: "world", newText: "durable" }] }),
      call("bash", { command: "printf 'bash:'; head -c 100 notes.txt" }),
      fauxAssistantMessage("The file now greets durable."),
    ])
    try {
      const receipt = await f.runtime.submit(requestId, "Greet durable instead")
      expect(receipt.status).toBe("pending")
      expect((await settled(f.runtime)).answer).toBe("The file now greets durable.")
      const { harness, root } = session(f.runtime)
      const entries = await root.entries({ order: "ascending" }, 100, undefined, context)
      const tools = entries.items.filter(ToolResultEntry.is)
      expect(
        tools
          .map((entry) => entry.model?.[0])
          .map((message) => message?.role === "toolResult" && message.toolName),
      ).toEqual(["write", "read", "edit", "bash"])
      expect(
        tools.every((entry) => entry.model?.[0]?.role === "toolResult" && !entry.model[0].isError),
      ).toBe(true)
      expect(await readFile(join(f.runtime.workspace, "notes.txt"), "utf8")).toBe("hello durable\n")
      expect((await root.agent(context)).maxTurns).toBe(LIMITS.maxTurns)
      expect(
        (await harness.commit((tx) => tx.scanConversations({}, 10), context)).items,
      ).toHaveLength(1)
      expect((await stat(`${f.runtime.database}-wal`)).size).toBeGreaterThan(32)
      expect(integrity(f.runtime.database)).toMatchObject({ integrity_check: "ok" })
    } finally {
      await f.cleanup()
    }
  })

  it("blocks effects after an uncertain file write, not just after a process crash", async () => {
    const original = NodeExecutionEnv.prototype.writeFile
    const fault = vi
      .spyOn(NodeExecutionEnv.prototype, "writeFile")
      .mockImplementation(async function (this: NodeExecutionEnv, path, content, ctx) {
        const result = await original.call(this, path, content, ctx)
        return path.endsWith("/partial.txt")
          ? { ok: false, error: new FileError("unknown", "injected lost write result", path) }
          : result
      })
    const f = await fixture([
      call("write", { path: "partial.txt", content: "effect" }),
      call("bash", { command: "printf repeated > repeated.txt" }),
      fauxAssistantMessage("must not be reported"),
    ])
    try {
      await f.runtime.submit(requestId, "write once")
      expect(await settled(f.runtime)).toMatchObject({
        status: "recovery_required",
        recoveryRequired: true,
      })
      expect(await readFile(join(f.runtime.workspace, "partial.txt"), "utf8")).toBe("effect")
      await expect(stat(join(f.runtime.workspace, "repeated.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      fault.mockRestore()
      await f.cleanup()
    }
  })

  it("allows a corrected edit after a pre-write mismatch", async () => {
    const f = await fixture([
      call("write", { path: "note.txt", content: "original" }),
      call("edit", { path: "note.txt", edits: [{ oldText: "absent", newText: "wrong" }] }),
      call("edit", { path: "note.txt", edits: [{ oldText: "original", newText: "corrected" }] }),
      fauxAssistantMessage("corrected"),
    ])
    try {
      await f.runtime.submit(requestId, "edit the note")
      expect(await settled(f.runtime)).toMatchObject({ status: "done", recoveryRequired: false })
      expect(await readFile(join(f.runtime.workspace, "note.txt"), "utf8")).toBe("corrected")
    } finally {
      await f.cleanup()
    }
  })

  it("blocks further effects after an unsafe shell timeout, including after reopen", async () => {
    const f = await fixture([
      call("bash", { command: "printf 'effect\\n' >> effects.txt; sleep 2", timeout: 0.05 }),
      call("bash", { command: "printf 'effect\\n' >> effects.txt" }),
      fauxAssistantMessage("must not report success"),
    ])
    let reopened: ActorRuntime | undefined
    try {
      await f.runtime.submit(requestId, "perform one effect")
      await eventually(
        () => f.runtime.status(requestId),
        (value) => value.status === "recovery_required",
      )
      await eventually(
        () => f.runtime.quiescence(),
        (value) => value.quiescent,
      )
      expect(await readFile(join(f.runtime.workspace, "effects.txt"), "utf8")).toBe("effect\n")
      const entries = await session(f.runtime).root.entries({}, 100, undefined, context)
      const results = entries.items.filter(ToolResultEntry.is)
      expect(
        results.some((entry) => entry.data.diagnostics.some((item) => item.code === "tool_error")),
      ).toBe(true)
      expect(
        results.some((entry) => entry.data.diagnostics.some((item) => item.code === "blocked")),
      ).toBe(true)
      await f.runtime.close()
      reopened = new ActorRuntime(f.options)
      expect((await reopened.status(requestId)).status).toBe("recovery_required")
      await expect(reopened.submit("telegram:42:999", "retry effect")).rejects.toMatchObject({
        code: "recovery_required",
      })
      expect(await readFile(join(f.runtime.workspace, "effects.txt"), "utf8")).toBe("effect\n")
    } finally {
      await reopened?.close()
      await f.cleanup()
    }
  })

  it("deduplicates repeated and concurrent IDs, rejects changed text, and reattaches after reopen", async () => {
    const f = await fixture([fauxAssistantMessage("one answer")])
    let reopened: ActorRuntime | undefined
    try {
      const admissions = await Promise.all(
        Array.from({ length: 12 }, () => f.runtime.submit(requestId, "same text")),
      )
      expect(new Set(admissions.map((item) => item.submissionId)).size).toBe(1)
      const completed = await settled(f.runtime)
      await expect(f.runtime.submit(requestId, "different")).rejects.toMatchObject({
        status: 409,
        code: "request_payload_mismatch",
      })
      const { harness, root } = session(f.runtime)
      const identity = await harness.snapshot(ProviderDoc, root.id, context)
      await f.runtime.close()
      reopened = new ActorRuntime(f.options)
      expect(await reopened.status(requestId)).toEqual(completed)
      expect(await reopened.submit(requestId, "same text")).toEqual(completed)
      const next = session(reopened)
      expect(await next.harness.snapshot(ProviderDoc, next.root.id, context)).toEqual(identity)
      expect(f.faux.state.callCount).toBe(1)
      expect(
        (await next.root.entries({}, 100, undefined, context)).items.filter(
          (entry) => entry.kind === "pi.user",
        ),
      ).toHaveLength(1)
      expect(integrity(reopened.database)).toMatchObject({ integrity_check: "ok" })
    } finally {
      await reopened?.close()
      await f.cleanup()
    }
  })

  it("uses separate Actor state and provider session IDs, and refuses cloned identities or another writer", async () => {
    const sessionIds: string[] = []
    const response = (_ctx: unknown, options: { sessionId?: string } | undefined) => {
      sessionIds.push(options?.sessionId ?? "missing")
      return fauxAssistantMessage("ok")
    }
    const a = await fixture([response])
    const b = await fixture([response], {
      identity: async () => ({ uid: "actor-b", name: "chat-b", atespace: "test" }),
    })
    let other: ActorRuntime | undefined
    try {
      await Promise.all([a.runtime.submit(requestId, "a"), b.runtime.submit(requestId, "b")])
      await Promise.all([settled(a.runtime), settled(b.runtime)])
      expect(sessionIds).toHaveLength(2)
      expect(sessionIds[0]).not.toBe("missing")
      expect(sessionIds[0]).not.toBe(sessionIds[1])
      expect(
        sessionIds.every((id) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
        ),
      ).toBe(true)
      other = new ActorRuntime(a.options)
      await expect(other.status(requestId)).rejects.toMatchObject({ code: "already_open" })
      await a.runtime.close()
      other = new ActorRuntime({ ...a.options, identity: b.options.identity })
      await expect(other.status(requestId)).rejects.toMatchObject({ code: "identity_mismatch" })
      expect(
        (await session(b.runtime).root.entries({}, 20, undefined, context)).items.some(
          (entry) => entry.model?.[0]?.role === "user" && entry.model[0].content === "a",
        ),
      ).toBe(false)
    } finally {
      await other?.close()
      await a.cleanup()
      await b.cleanup()
    }
  })

  it("retains raw history after compaction, including old duplicate payload checks", async () => {
    const f = await fixture(
      Array.from({ length: 5 }, () => fauxAssistantMessage("response ".repeat(1500))),
    )
    try {
      for (let index = 0; index < 4; index++) {
        await f.runtime.submit(
          `telegram:42:${index}`,
          `message-${index} ${"old history ".repeat(1000)}`,
        )
        await settled(f.runtime, `telegram:42:${index}`)
      }
      const { harness, root } = session(f.runtime)
      const before = await root.entries({ order: "ascending" }, 100, undefined, context)
      f.faux.setResponses([fauxAssistantMessage("summary of the old history")])
      const compaction = await harness.waitForTask(await root.compact(undefined, context), context)
      expect(compaction.state.outcome.status).toBe("completed")
      await eventually(
        () => f.runtime.quiescence(),
        (value) => value.quiescent,
      )
      const after = await root.entries({ order: "ascending" }, 100, undefined, context)
      expect(after.items.some((entry) => entry.kind === "pi.compaction")).toBe(true)
      expect(before.items.every((entry) => after.items.some((item) => item.id === entry.id))).toBe(
        true,
      )
      expect((await root.context(context)).entries.length).toBeLessThan(after.items.length)
      await expect(f.runtime.submit("telegram:42:0", "changed old payload")).rejects.toMatchObject({
        code: "request_payload_mismatch",
      })
    } finally {
      await f.cleanup()
    }
  })

  it("reports sleeping background work as non-quiescent even when Pi ordinary idle resolves", async () => {
    const Sleep = defineTask<null, { phase: "sleep" } | { phase: "end" }, null>({
      name: "test.sleep",
      version: 1,
      initial: () => ({ phase: "sleep" }),
      phases: {
        sleep: (_task, runtime, ctx) =>
          runtime.sleepUntil(Date.now() + 60_000, { phase: "end" }, ctx),
        end: (_task, runtime, ctx) =>
          runtime
            .commit(
              () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
              ctx,
            )
            .then(() => {}),
      },
      abort: (_task, runtime, ctx) =>
        runtime
          .commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx)
          .then(() => {}),
    })
    const f = await fixture([fauxAssistantMessage("done")], {
      install: (registry) => registry.install(defineExtension({ name: "sleep", tasks: [Sleep] })),
    })
    try {
      await f.runtime.submit(requestId, "start")
      await settled(f.runtime)
      const { harness, root } = session(f.runtime)
      await root.commit(
        (tx) =>
          tx.createTask(Sleep, null, { ownership: { kind: "conversation" }, background: true }),
        context,
      )
      harness.resume()
      await eventually(
        () => f.runtime.quiescence(),
        (value) => !value.active && value.wakeAt !== undefined,
      )
      await harness.waitForIdle(context)
      expect(await f.runtime.quiescence()).toMatchObject({ quiescent: false, active: false })
      await expect(f.runtime.submit("telegram:42:101", "next")).rejects.toMatchObject({
        code: "busy",
      })
    } finally {
      await f.cleanup()
    }
  })

  it("applies finite turns, retained tool output, and bash timeout limits", async () => {
    const timeouts: unknown[] = []
    const f = await fixture(
      [
        call("bash", { command: "printf 'x%.0s' {1..30000}", timeout: 999999 }),
        ...Array.from({ length: LIMITS.maxTurns }, (_, index) =>
          call("read", { path: "absent.txt" }, `read-${index}`),
        ),
      ],
      {
        install: (registry) =>
          registry.install(
            defineExtension({
              name: "capture-timeout",
              hooks: [
                hook(ToolTask, {
                  beforeTool: (call) => {
                    if (call.name === "bash") timeouts.push(call.arguments.timeout)
                    return undefined
                  },
                }),
              ],
            }),
          ),
      },
    )
    try {
      await f.runtime.submit(requestId, "loop")
      const outcome = await settled(f.runtime)
      expect(outcome).toMatchObject({ status: "unanswered", reason: "turn_limit" })
      const { root } = session(f.runtime)
      const entries = (await root.entries({}, 100, undefined, context)).items
      const toolResults = entries.filter(ToolResultEntry.is)
      expect(toolResults).toHaveLength(LIMITS.maxTurns)
      const bash = toolResults.find(
        (entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "bash",
      )
      const output = bash?.model?.[0]
      expect(output?.role).toBe("toolResult")
      if (output?.role !== "toolResult") throw new Error("missing bash output")
      expect(
        output.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("").length,
      ).toBeLessThan(LIMITS.toolOutputBytes + 1000)
      expect(bash?.data.diagnostics.some((item) => item.code === "truncated")).toBe(true)
      expect(timeouts).toEqual([LIMITS.bashTimeoutSeconds])
    } finally {
      await f.cleanup()
    }
  })

  it("keeps a settled answer separate from running compaction and failed model outcomes", async () => {
    let release: (() => void) | undefined
    let summarizing = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = await fixture([
      fauxAssistantMessage("answer ".repeat(2000)),
      fauxAssistantMessage("second ".repeat(2000)),
    ])
    try {
      await f.runtime.submit(requestId, "old context ".repeat(1000))
      await settled(f.runtime)
      await f.runtime.submit("telegram:42:101", "recent context ".repeat(1000))
      await settled(f.runtime, "telegram:42:101")
      f.faux.setResponses([
        async () => {
          summarizing = true
          await gate
          return fauxAssistantMessage("summary")
        },
      ])
      await session(f.runtime).root.compact(undefined, context)
      await eventually(async () => summarizing, Boolean)
      expect((await f.runtime.status(requestId)).status).toBe("done")
      expect((await f.runtime.quiescence()).quiescent).toBe(false)
      await expect(
        f.runtime.submit("telegram:42:102", "blocked during compaction"),
      ).rejects.toMatchObject({ code: "busy" })
      release?.()
      await eventually(
        () => f.runtime.quiescence(),
        (value) => value.quiescent,
      )
      f.faux.setResponses([
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "400 Invalid synthetic request",
        }),
      ])
      await f.runtime.submit("telegram:42:102", "fail request")
      const failed = await settled(f.runtime, "telegram:42:102")
      expect(failed).toMatchObject({ status: "unanswered", reason: "model_error" })
      expect(failed.answer).toBeUndefined()
    } finally {
      release?.()
      await f.cleanup()
    }
  })

  it("checks live WAL and workspace with the runtime suite's read-only tool probe", async () => {
    const f = await fixture([
      call("write", { path: "fixture.txt", content: "fixture tool output\\n" }),
      fauxAssistantMessage("ok"),
    ])
    try {
      await f.runtime.submit(requestId, "WAL and workspace sentinel")
      await settled(f.runtime)
      const before = (await stat(`${f.runtime.database}-wal`)).size
      const output = execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("./actor/storage-proof.mjs", import.meta.url)),
          f.runtime.database,
          f.runtime.workspace,
        ],
        { timeout: 10_000 },
      )
      const proof = JSON.parse(output.toString())
      expect(proof).toMatchObject({
        integrity: "ok",
        walBytes: before,
        workspace: "fixture tool output\\n",
        mainContainsSentinel: false,
        walContainsSentinel: true,
      })
      expect(proof.userEntries).toHaveLength(1)
      expect(proof.userEntries[0].content).toBe("WAL and workspace sentinel")
      expect(proof.providerSessionId).toBeTruthy()
      expect((await stat(`${f.runtime.database}-wal`)).size).toBe(before)
    } finally {
      await f.cleanup()
    }
  })

  it("stops bash at its finite requested timeout and requires effect reconciliation", async () => {
    const f = await fixture([
      call("bash", { command: "printf before; sleep 1; printf after > late.txt", timeout: 0.03 }),
      fauxAssistantMessage("command timed out"),
    ])
    try {
      await f.runtime.submit(requestId, "bounded command")
      expect(await settled(f.runtime)).toMatchObject({
        status: "recovery_required",
        recoveryRequired: true,
      })
      const result = (await session(f.runtime).root.entries({}, 30, undefined, context)).items.find(
        ToolResultEntry.is,
      )
      expect(result?.model?.[0]).toMatchObject({ role: "toolResult", isError: true })
      expect(JSON.stringify(result)).toContain("timed out")
      await expect(stat(join(f.runtime.workspace, "late.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      await f.cleanup()
    }
  })

  it("configures only OpenAI Responses with explicit endpoint and deployment metadata", () => {
    const env = {
      OPENAI_API_KEY: PLACEHOLDER_KEY,
      OPENAI_BASE_URL: "https://fixture.test/openai/v1",
      OPENAI_MODEL: "my-deployment",
      OPENAI_MODEL_METADATA: "gpt-4o-mini",
    }
    const configured = openAIModels(env)
    const model = configured.models.getModel("openai", "my-deployment")
    expect(configured.models.getProviders().map((provider) => provider.id)).toEqual(["openai"])
    expect(model).toMatchObject({
      id: "my-deployment",
      provider: "openai",
      api: "openai-responses",
      baseUrl: env.OPENAI_BASE_URL,
      maxTokens: LIMITS.modelOutputTokens,
    })
    expect(model?.contextWindow).toBeGreaterThan(LIMITS.modelOutputTokens)
    expect(() => openAIModels({ ...env, OPENAI_API_KEY: "real-secret-not-allowed" })).toThrow(
      "placeholder",
    )
    expect(() => openAIModels({ ...env, OPENAI_BASE_URL: "http://fixture.test/v1" })).toThrow(
      "HTTPS",
    )
    expect(() => openAIModels({ ...env, OPENAI_MODEL_METADATA: "unknown" })).toThrow("metadata")
  })
})
