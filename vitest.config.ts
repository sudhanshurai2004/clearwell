import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Integration tests touch a real PostgreSQL; run them serially so they do
    // not fight over migrations or truncate each other's rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    reporters: ["default"],
    globalSetup: ["tests/setup/global.ts"],
  },
});
