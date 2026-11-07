import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/telegram-postgres.test.ts", "tests/delivery-postgres.test.ts"],
  },
})
