import { readFileSync } from "node:fs"
import { Agent } from "undici"

/** One fresh, verified connection generation per provider request, including after warm restore. */
export function rotatingProviderFetch(caFile: string): typeof globalThis.fetch {
  return async (input, init) => {
    const ca = readFileSync(caFile)
    if (ca.length === 0 || ca.length > 1_048_576) throw new Error("Invalid Actor trust bundle")
    const dispatcher = new Agent({
      connect: { ca, rejectUnauthorized: true },
      maxCachedSessions: 0,
    })
    try {
      const options: RequestInit & { dispatcher: Agent } = {
        ...init,
        dispatcher,
        redirect: "error",
      }
      const response = await fetch(input, options)
      // close() drains the response body. Do not await it before the adapter consumes its stream.
      void dispatcher
        .close()
        .catch(() => dispatcher.destroy())
        .catch(() => {})
      return response
    } catch (error) {
      await dispatcher.destroy().catch(() => {})
      throw error
    }
  }
}
