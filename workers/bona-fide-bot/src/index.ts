import fetch from "./fetch/index.ts";
import type { Env } from "./types/cloudflare.ts";

export default {
  fetch,
} satisfies ExportedHandler<Env>;
