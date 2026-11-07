import { defineConfig } from "vitest/config"

// Not in the default *.test.ts suite. Missing PostgreSQL is a failure, never a skip.
export default defineConfig({
  test: {
    include: [
      "tests/store.integration.ts",
      "tests/telegram-postgres.test.ts",
      "tests/delivery-postgres.test.ts",
      "tests/dispatch.integration.ts",
      "tests/leader.integration.ts",
    ],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
