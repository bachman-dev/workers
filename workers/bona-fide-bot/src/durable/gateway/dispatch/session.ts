import { GatewayDispatchEvents } from "@bachman-dev/workers-shared/discord";

import logDispatch from "./log.ts";
import type { DispatchHandlers } from "./types.ts";

/**
 * Session events that every connection receives. The shard records session state from these before the handlers run, so
 * handlers here only react to them.
 */
const sessionHandlers = {
  [GatewayDispatchEvents.Ready]: (payload, context): void => {
    logDispatch(context, payload, {
      applicationId: payload.d.application.id,
      guilds: payload.d.guilds.length,
      shard: payload.d.shard,
      user: payload.d.user.username,
    });
  },
  [GatewayDispatchEvents.Resumed]: (payload, context): void => {
    logDispatch(context, payload);
  },
} satisfies DispatchHandlers;

export default sessionHandlers;
