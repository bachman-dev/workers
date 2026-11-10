import { APIVersion, REST, type RESTGetAPIGatewayBotResult, Routes } from "@bachman-dev/workers-shared/discord";

import { HTTP_UNAUTHORIZED } from "./constants.ts";

function isGatewayBotResult(value: unknown): value is RESTGetAPIGatewayBotResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof value.url === "string" &&
    "shards" in value &&
    typeof value.shards === "number" &&
    "session_start_limit" in value &&
    typeof value.session_start_limit === "object" &&
    value.session_start_limit !== null
  );
}

/**
 * Calls Get Gateway Bot for the WSS URL, recommended shard count and session start limits. Discord says not to cache
 * this for long, so callers fetch it whenever they're about to identify.
 *
 * @param {string} token - The bot token.
 * @returns {Promise<RESTGetAPIGatewayBotResult>} The gateway URL, recommended shards and session start limit.
 */
export async function getGatewayBot(token: string): Promise<RESTGetAPIGatewayBotResult> {
  // Sweepers are setInterval timers, which would keep a Durable Object from being evicted.
  const rest = new REST({ handlerSweepInterval: 0, hashSweepInterval: 0, version: APIVersion }).setToken(token);
  const result = await rest.get(Routes.gatewayBot());
  if (!isGatewayBotResult(result)) {
    throw new TypeError("Unexpected response from Get Gateway Bot");
  }
  return result;
}

/**
 * Checks whether a Discord REST error means the bot token was rejected.
 *
 * @param {unknown} error - The error thrown by the REST client.
 * @returns {boolean} True for an HTTP 401 response.
 */
export function isUnauthorizedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === HTTP_UNAUTHORIZED;
}

/**
 * Names a shard's Durable Object; shards are addressed by index so the cron can find them again.
 *
 * @param {number} shardId - The zero-based shard ID.
 * @returns {string} The name to pass to `getByName`.
 */
export function shardName(shardId: number): string {
  return `shard-${shardId}`;
}
