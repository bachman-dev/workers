import fetch from "./fetch/index.ts";
import scheduled from "./scheduled/index.ts";
import type { Env } from "./types/cloudflare.ts";

export { default as DiscordGateway } from "./durable/gateway.ts";

export default {
  fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
