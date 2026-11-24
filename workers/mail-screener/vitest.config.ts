import { createRequire } from "node:module";
import path from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Resolve discord-api-types from workers-shared, which depends on it
const requireFromShared = createRequire(path.join(import.meta.dirname, "../../packages/workers-shared/package.json"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Stand-ins for the secrets; the real values stay in the Cloudflare dashboard.
        bindings: {
          DESTINATION: "inbox@example.com",
          DISCORD_APP_ID: "100000000000000001",
          DISCORD_CHANNEL_ID: "200000000000000002",
        },
        // Nothing here should reach the network; fail anything that tries instead of sending it
        outboundService: (request) =>
          new Response(`Unexpected outbound request in tests: ${request.method} ${request.url}`, { status: 400 }),
      },
    }),
  ],
  resolve: {
    alias: [
      // The ES module wrapper reads every export off the CommonJS module's default export, which the Workers test
      // runner leaves without the re-exported enums. Import the CommonJS module directly so its named exports are used.
      { find: "discord-api-types/v10", replacement: requireFromShared.resolve("discord-api-types/v10") },
    ],
  },
  // Spies on the Screener are put back after each test
  test: { restoreMocks: true, setupFiles: ["./tests/setup.ts"] },
});
