import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: { generator: "oxc", sourcemap: false },
  entry: ["src/cloudflare/index.ts", "src/discord/index.ts", "src/http/index.ts", "src/util/index.ts"],
  format: "esm",
  target: "es2025",
});
