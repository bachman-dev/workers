import email from "./email/index.ts";
import type { Env } from "./types/cloudflare.ts";

export { default as Screener } from "./durable/screener.ts";
export { default as ScreenerService } from "./rpc/index.ts";

export default {
  email,
} satisfies ExportedHandler<Env>;
