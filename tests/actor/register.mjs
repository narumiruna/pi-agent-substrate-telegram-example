import { existsSync } from "node:fs"
import { registerHooks } from "node:module"

// Run crash probes against current TypeScript, not stale dist output.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
        const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
        if (existsSync(source)) return nextResolve(source.href, context)
      }
      throw error
    }
  },
})
