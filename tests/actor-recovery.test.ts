import { fork } from "node:child_process"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import { ToolResultEntry } from "@earendil-works/pi-durable"
import { expect, it } from "vitest"
import { ActorRuntime } from "../src/actor/runtime.js"
import { call, context, fixture, requestId, session, settled } from "./actor/helpers.js"

for (const mode of ["tool", "model"] as const) {
  it(`recovers an actual SIGKILL during ${mode}, without replaying an unsafe effect`, async () => {
    const f = await fixture(
      mode === "model"
        ? [fauxAssistantMessage("recovered model request")]
        : [
            call("bash", { command: "printf 'should-not-run' >> effects.txt" }, "repeat"),
            fauxAssistantMessage("tool outcome uncertain"),
          ],
    )
    const child = fork(
      fileURLToPath(new URL("./actor/crash-child.ts", import.meta.url)),
      [f.directory, mode],
      {
        execArgv: ["--import", fileURLToPath(new URL("./actor/register.mjs", import.meta.url))],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    )
    let stderr = ""
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    let reopened: ActorRuntime | undefined
    let toolPid: number | undefined
    try {
      await Promise.race([
        once(child, "message"),
        once(child, "exit").then(([code]) => {
          throw new Error(`Crash probe exited ${code}: ${stderr}`)
        }),
      ])
      if (mode === "tool")
        toolPid = Number(await readFile(join(f.runtime.workspace, "tool-pid.txt"), "utf8"))
      // A competing process must not open this writer, even when its SQLite is idle between commits.
      await expect(f.runtime.status(requestId)).rejects.toMatchObject({ code: "already_open" })
      const exited = once(child, "exit")
      child.kill("SIGKILL")
      expect((await exited)[1]).toBe("SIGKILL")
      if (toolPid) {
        try {
          process.kill(-toolPid, "SIGKILL")
        } catch {}
        toolPid = undefined
      }
      reopened = new ActorRuntime(f.options)
      const first = await reopened.status(requestId)
      expect(first.submissionId).toBeTruthy()
      const result = await settled(reopened)
      if (mode === "tool") {
        expect(result.status).toBe("recovery_required")
        expect(result.answer).toBeUndefined()
        expect(await readFile(join(reopened.workspace, "effects.txt"), "utf8")).toBe("effect\n")
        const entries = (
          await session(reopened).root.entries({}, 100, undefined, context)
        ).items.filter(ToolResultEntry.is)
        expect(
          entries.some((entry) =>
            entry.data.diagnostics.some((item) => item.code === "interrupted"),
          ),
        ).toBe(true)
        expect(
          entries.some((entry) => entry.data.diagnostics.some((item) => item.code === "blocked")),
        ).toBe(true)
        await expect(reopened.submit("telegram:42:101", "start again")).rejects.toMatchObject({
          code: "recovery_required",
        })
        const same = await reopened.submit(requestId, "crash test")
        expect(same).toMatchObject({
          submissionId: first.submissionId,
          status: "recovery_required",
        })
        await reopened.close()
        reopened = new ActorRuntime(f.options)
        expect((await reopened.status(requestId)).status).toBe("recovery_required")
      } else {
        expect(result).toMatchObject({ status: "done", answer: "recovered model request" })
        expect(f.faux.state.callCount).toBe(1)
      }
    } finally {
      child.kill("SIGKILL")
      if (toolPid) {
        try {
          process.kill(-toolPid, "SIGKILL")
        } catch {}
      }
      await reopened?.close()
      await f.cleanup()
    }
  }, 15_000)
}
