import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The integration test spawns the built CLI and a real model round-trip
    // can be slow; give the suite generous headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
