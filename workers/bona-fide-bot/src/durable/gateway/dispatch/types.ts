import type { DispatchHandlers as SharedDispatchHandlers } from "@bachman-dev/workers-shared/discord";

import type { Env } from "../../../types/cloudflare.ts";

/** What a dispatch handler gets besides the event itself. */
export interface DispatchContext {
  env: Env;
  shardId: number;
}

/** This bot's handlers, keyed by event name; each module covers the events for one intent. */
export type DispatchHandlers = SharedDispatchHandlers<DispatchContext>;
