import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["server/index.ts", "server/preview.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist/server",
  clean: true,
  removeNodeProtocol: false,
});
