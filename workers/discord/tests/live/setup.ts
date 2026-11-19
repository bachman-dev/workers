import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

import liveDiscord from "./discord.ts";

const { applicationId, botToken } = liveDiscord();

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// The token only goes into the throwaway local database
await env.DB.prepare("INSERT INTO apps (id, token) VALUES (?, ?)").bind(applicationId, botToken).run();
