import type { DiscordMessageQueueBody } from "@bachman-dev/workers-shared/discord";

export interface Env extends Cloudflare.Env {
  DISCORD_QUEUE: Queue<DiscordMessageQueueBody>;
}
