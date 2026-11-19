import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** The drizzle migrations, read by vitest.config.ts and applied in tests/setup.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
