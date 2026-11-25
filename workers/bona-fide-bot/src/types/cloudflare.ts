import type { DiscordMessageQueueBody } from "@bachman-dev/workers-shared/discord";
import type { ScreenerServiceRpc } from "@bachman-dev/workers-shared/screener";

import type DiscordGateway from "../durable/gateway.ts";

export interface Env extends Omit<Cloudflare.Env, "SCREENER"> {
  DISCORD_QUEUE: Queue<DiscordMessageQueueBody>;
  // The generated binding type uses an extensionless import that type-aware linting can't resolve.
  GATEWAY: DurableObjectNamespace<DiscordGateway>;
  // The ScreenerService from mail-screener, typed from the shared contract. Previews don't get it, so it can be missing.
  SCREENER?: ScreenerServiceRpc;
}
