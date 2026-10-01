import { defineConfig } from "vitest/config";

export default defineConfig({
  // Real-runner tests install packages and start servers.
  test: { include: ["test/**/*.test.ts"], testTimeout: 240_000, hookTimeout: 240_000 },
});
