import type { D1Migration } from "cloudflare:test";

import type { LiveDiscord } from "./live/types.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      /** The drizzle migrations, read by vitest.config.ts and applied by the setup files. */
      TEST_MIGRATIONS: D1Migration[];
      /** What `pnpm test:live` posts with, read from the environment by vitest.config.ts; only set in live mode. */
      LIVE_DISCORD?: LiveDiscord;
    }
  }
}
