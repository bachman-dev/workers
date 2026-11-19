import { createRequire } from "node:module";
import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Resolve discord-api-types from workers-shared, which depends on it
const requireFromShared = createRequire(path.join(import.meta.dirname, "../../packages/workers-shared/package.json"));

export default defineConfig(async () => {
  const migrations = await readD1Migrations({
    projectPath: import.meta.dirname,
    migrationsDir: "drizzle",
    migrationsPattern: "drizzle/*/migration.sql",
  });
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          // Discord is mocked in tests/setup.ts; fail anything that gets past the mock instead of sending it
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
    test: {
      setupFiles: ["./tests/setup.ts"],
    },
  };
});
