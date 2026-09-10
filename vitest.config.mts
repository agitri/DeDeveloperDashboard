import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // DDD_HOME is process-global. One process per test file means a file can
    // point it at a scratch directory without racing another file.
    pool: "forks",
  },
});
