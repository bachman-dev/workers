import type { DispatchPayload, GatewayDispatchEvents } from "@bachman-dev/workers-shared/discord";

import guildInvitesHandlers from "./guild-invites.ts";
import guildsHandlers from "./guilds.ts";
import logDispatch from "./log.ts";
import sessionHandlers from "./session.ts";
import type { DispatchContext, DispatchHandlers } from "./types.ts";

const handlers: DispatchHandlers = {
  ...sessionHandlers,
  ...guildsHandlers,
  ...guildInvitesHandlers,
};

/**
 * Runs the handler registered for a dispatch event, or logs the event if nothing handles it. Handlers run one at a
 * time, in the order Discord sent the events.
 *
 * @param {DispatchPayload} payload - The dispatch payload.
 * @param {DispatchContext} context - The shard the event arrived on.
 */
export async function handleDispatch<Event extends GatewayDispatchEvents>(
  payload: DispatchPayload<Event> & { t: Event },
  context: DispatchContext,
): Promise<void> {
  const handler = handlers[payload.t];
  if (typeof handler === "undefined") {
    logDispatch(context, payload);
    return;
  }
  await handler(payload, context);
}

export type { DispatchContext } from "./types.ts";
