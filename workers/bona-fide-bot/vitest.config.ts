import { createRequire } from "node:module";
import path from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** An Ed25519 public key is 32 bytes. */
const PUBLIC_KEY_BYTES = 32;

// Resolve discord-api-types from workers-shared, which depends on it
const requireFromShared = createRequire(path.join(import.meta.dirname, "../../packages/workers-shared/package.json"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Stand-ins for the secrets; the real values stay in the Cloudflare dashboard. Tests that verify signatures
        // swap in a public key they make themselves.
        bindings: {
          BASE_PATH: "/interactions",
          DISCORD_APP_ID: "100000000000000001",
          DISCORD_APP_SECRET: "placeholder-app-secret",
          DISCORD_OWNER_ID: "300000000000000003",
          DISCORD_PUBLIC_KEY: "00".repeat(PUBLIC_KEY_BYTES),
        },
        // The mail-screener worker doesn't run in these tests; each test passes a fake SCREENER in its bindings instead
        serviceBindings: {
          SCREENER: () => new Response("mail-screener isn't running in tests", { status: 503 }),
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
  // Spies on the queue are put back after each test
  test: { restoreMocks: true, setupFiles: ["./tests/setup.ts"] },
});
