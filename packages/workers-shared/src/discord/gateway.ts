import type { GatewayDispatchEvents, GatewayDispatchPayload } from "discord-api-types/v10";

import type { MaybePromise } from "../util/types.ts";

/** The Gateway dispatch payload for one event name, e.g. `DispatchPayload<GatewayDispatchEvents.GuildCreate>`. */
export type DispatchPayload<Event extends GatewayDispatchEvents> = Extract<GatewayDispatchPayload, { t: Event }>;

/**
 * Handles one Gateway dispatch event. `Context` is whatever the caller passes alongside each event, such as bindings
 * and the shard ID. Handlers may be sync or async.
 */
export type DispatchHandler<Event extends GatewayDispatchEvents, Context> = (
  payload: DispatchPayload<Event>,
  context: Context,
) => MaybePromise<void>;

/** Dispatch handlers keyed by event name; leave out events that need no handling. */
export type DispatchHandlers<Context> = { [Event in GatewayDispatchEvents]?: DispatchHandler<Event, Context> };
