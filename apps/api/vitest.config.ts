import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 90_000,
    // Each test file gets its own throw-away database; files run in parallel.
    fileParallelism: true,
  },
});
