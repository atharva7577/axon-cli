import { defineConfig } from "tsup";

export default defineConfig({
  entry:  ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean:  true,
  splitting: false,
  sourcemap: false,
  shims: true,
  banner: { js: "#!/usr/bin/env node" },
  dts: false,
  // Keep node_modules external. `npm i -g @axon/cli` installs the deps from
  // package.json into the global node_modules, and ESM-only packages
  // (commander v14 / chalk / ora) work fine when imported normally — bundling
  // them via tsup's CJS shim breaks Node's `events` resolution.
});
