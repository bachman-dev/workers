import { createRequire } from "node:module";
import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import type { LiveDiscord } from "./tests/live/types.ts";

// Resolve discord-api-types from workers-shared, which depends on it
const requireFromShared = createRequire(path.join(import.meta.dirname, "../../packages/workers-shared/package.json"));

/**
 * Reads a required environment variable for `pnpm test:live`.
 *
 * @param {string} name - The variable's name.
 * @returns {string} Its value.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Set ${name} to run the live test`);
  }
  return value;
}

/**
 * Reads the bot, channel and ref for `pnpm test:live` from the environment, so they stay out of the repo.
 *
 * @returns {LiveDiscord} What the live test posts with.
 */
function liveDiscord(): LiveDiscord {
  return {
    applicationId: requireEnv("DISCORD_APPLICATION_ID"),
    channelId: requireEnv("DISCORD_CHANNEL_ID"),
    botToken: requireEnv("DISCORD_BOT_TOKEN"),
    ref: process.env.DISCORD_REF ?? "test:message-refs:1",
  };
}

// `pnpm test` runs the mocked tests. `pnpm test:live` (`--mode live`) runs tests/live against real Discord, with the
// worker and a throwaway D1 database running locally, so nothing touches the Cloudflare account.
export default defineConfig(async ({ mode }) => {
  const live = mode === "live";
  const migrations = await readD1Migrations({
    projectPath: import.meta.dirname,
    migrationsDir: "drizzle",
    migrationsPattern: "drizzle/*/migration.sql",
  });
  return {
    plugins: [
      live
        ? cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations, LIVE_DISCORD: { ...liveDiscord() } } },
          })
        : cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: { TEST_MIGRATIONS: migrations },
              // Discord is mocked in tests/setup.ts; fail anything that gets past the mock instead of sending it
              outboundService: (request) =>
                new Response(`Unexpected outbound request in tests: ${request.method} ${request.url}`, {
                  status: 400,
                }),
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
    test: live
      ? { include: ["tests/live/**/*.live.ts"], setupFiles: ["./tests/live/setup.ts"] }
      : { setupFiles: ["./tests/setup.ts"] },
  };
});
