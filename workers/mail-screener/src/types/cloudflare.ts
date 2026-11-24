import type { DiscordMessageQueueBody } from "@bachman-dev/workers-shared/discord";

import type Screener from "../durable/screener.ts";

export interface Env extends Cloudflare.Env {
  DISCORD_QUEUE: Queue<DiscordMessageQueueBody>;
  // The generated binding type uses an extensionless import that type-aware linting can't resolve.
  SCREENER: DurableObjectNamespace<Screener>;
}
