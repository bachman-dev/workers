import type { DiscordSyncCommandsQueueBody } from "@bachman-dev/workers-shared/discord";

import type { Env } from "../types/cloudflare.ts";
import { COMMANDS } from "./index.ts";

/** The name the discord worker knows this worker's commands by, in `command_guilds` and `command_syncs`. */
const WORKER_NAME = "bona-fide-bot";

/**
 * Builds the sync of every command in the registry, global and guild, for the bot's application.
 *
 * @param {Env} env - The worker's bindings, which name the application.
 * @returns {DiscordSyncCommandsQueueBody} The queued body.
 */
function buildCommandSync(env: Env): DiscordSyncCommandsQueueBody {
  return {
    op: "sync-commands",
    applicationId: env.DISCORD_APP_ID,
    worker: WORKER_NAME,
    commands: COMMANDS.map((command) => {
      return { scope: command.scope, data: command.data };
    }),
  };
}

/**
 * Queues the command sync for the discord worker. It skips any scope whose commands haven't changed, so sending this on
 * every cron run only calls Discord after a deploy or a `command_guilds` change.
 *
 * @param {Env} env - The worker's bindings.
 * @returns {Promise<void>} Resolves once the body is queued.
 */
async function queueCommandSync(env: Env): Promise<void> {
  await env.DISCORD_QUEUE.send(buildCommandSync(env), { contentType: "json" });
}

export { WORKER_NAME, buildCommandSync, queueCommandSync };
