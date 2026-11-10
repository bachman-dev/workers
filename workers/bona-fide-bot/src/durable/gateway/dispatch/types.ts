import type { GatewayDispatchEvents, GatewayDispatchPayload } from "@bachman-dev/workers-shared/discord";

import type { Env } from "../../../types/cloudflare.ts";

type MaybePromise<Value> = Promise<Value> | Value;

/** What a dispatch handler gets besides the event itself. */
export interface DispatchContext {
  env: Env;
  shardId: number;
}

/** The dispatch payload for one event name. */
export type DispatchPayload<Event extends GatewayDispatchEvents> = Extract<GatewayDispatchPayload, { t: Event }>;

/** Handlers may be sync or async; the shard runs them one at a time, in the order Discord sent them. */
export type DispatchHandler<Event extends GatewayDispatchEvents> = (
  payload: DispatchPayload<Event>,
  context: DispatchContext,
) => MaybePromise<void>;

/** Handlers keyed by event name; each module covers the events for one intent. */
export type DispatchHandlers = { [Event in GatewayDispatchEvents]?: DispatchHandler<Event> };
