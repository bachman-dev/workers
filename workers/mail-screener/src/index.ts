import { log } from "@bachman-dev/workers-shared/util";

import type { Env } from "./types/cloudflare.ts";

export { default as Screener } from "./screener.ts";

export default {
  email: (message): void => {
    log("info", "Received mail", message.to);
  },
} satisfies ExportedHandler<Env>;
