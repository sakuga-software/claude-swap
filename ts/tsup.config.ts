import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
