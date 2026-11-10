import { GatewayDispatchEvents } from "@bachman-dev/workers-shared/discord";

import logDispatch from "./log.ts";
import type { DispatchHandlers } from "./types.ts";

/** Events for the GUILD_INVITES intent. */
const guildInvitesHandlers = {
  [GatewayDispatchEvents.InviteCreate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.InviteDelete]: (payload, context): void => {
    logDispatch(context, payload);
  },
} satisfies DispatchHandlers;

export default guildInvitesHandlers;
