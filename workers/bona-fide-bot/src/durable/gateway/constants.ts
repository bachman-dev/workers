import { GatewayCloseCodes, GatewayIntentBits } from "@bachman-dev/workers-shared/discord";

/** Intents requested when identifying. Interactions arrive over HTTP, so only guild events are needed here. */
// oxlint-disable-next-line no-bitwise -- Intents are bit flags
export const GATEWAY_INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildInvites;

/** Identify connection properties; these show up in Discord's session info, not to users. */
export const IDENTIFY_PROPERTIES = {
  browser: "bona-fide-bot",
  device: "bona-fide-bot",
  os: "cloudflare-workers",
} as const;

/** The activity rotates on this interval, aligned to the top of each UTC hour. */
export const ACTIVITY_ROTATION_INTERVAL_MS = 3_600_000;

/** How long to wait for Hello after the socket opens before treating the connection as dead. */
export const HELLO_TIMEOUT_MS = 20_000;

/** Reconnect backoff: the first retry is immediate (plus jitter), later ones double up to the cap. */
export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 60_000;
export const RECONNECT_JITTER_MS = 1000;

/** Discord asks for a random 1-5 second wait after an Invalid Session before identifying again. */
export const INVALID_SESSION_MIN_DELAY_MS = 1000;
export const INVALID_SESSION_MAX_DELAY_MS = 5000;

/** Identify rate limit window; shards in later `max_concurrency` buckets wait this long per bucket. */
export const IDENTIFY_BUCKET_INTERVAL_MS = 5500;

/**
 * Close code this DO sends when it drops a connection it intends to resume. Anything but 1000/1001 keeps the session
 * alive on Discord's side.
 */
export const RESUMABLE_CLOSE_CODE = 4000;

/** Close code that ends the session on Discord's side, used when stopping or re-sharding. */
export const SESSION_ENDING_CLOSE_CODE = 1000;

/** Close codes that will fail again on retry until the token, intents, API version or shard config changes. */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  GatewayCloseCodes.AuthenticationFailed,
  GatewayCloseCodes.InvalidShard,
  GatewayCloseCodes.ShardingRequired,
  GatewayCloseCodes.InvalidAPIVersion,
  GatewayCloseCodes.InvalidIntents,
  GatewayCloseCodes.DisallowedIntents,
]);

/** Close codes that can be retried, but only with a new session (Identify instead of Resume). */
export const SESSION_INVALIDATING_CLOSE_CODES: ReadonlySet<number> = new Set([
  GatewayCloseCodes.InvalidSeq,
  GatewayCloseCodes.SessionTimedOut,
]);

/** HTTP status Discord returns from Get Gateway Bot when the bot token is invalid. */
export const HTTP_UNAUTHORIZED = 401;
