import { env } from "cloudflare:workers";

import type { LiveDiscord } from "./types.ts";

/**
 * Gets the bot, channel and ref for the live run.
 *
 * @returns {LiveDiscord} What the live test posts with.
 */
export default function liveDiscord(): LiveDiscord {
  if (env.LIVE_DISCORD === undefined) {
    throw new Error("Run the live tests with `pnpm test:live`");
  }
  return env.LIVE_DISCORD;
}
