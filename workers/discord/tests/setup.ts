import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

import { mockDiscord, resetDiscord } from "./discord.ts";

mockDiscord();
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  resetDiscord();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM message_refs"),
    env.DB.prepare("DELETE FROM apps"),
    env.DB.prepare("DELETE FROM webhooks"),
    env.DB.prepare("DELETE FROM command_guilds"),
    env.DB.prepare("DELETE FROM command_syncs"),
    env.DB.prepare("INSERT INTO apps (id, token) VALUES ('100', 'bot-token')"),
    env.DB.prepare("INSERT INTO webhooks (id, token) VALUES ('200', 'webhook-token')"),
  ]);
});
