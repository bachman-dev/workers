import { GatewayDispatchEvents } from "@bachman-dev/workers-shared/discord";

import logDispatch from "./log.ts";
import type { DispatchHandlers } from "./types.ts";

/** Events for the GUILDS intent. */
const guildsHandlers = {
  // Guilds
  [GatewayDispatchEvents.GuildCreate]: (payload, context): void => {
    // The full payload carries every channel, role, member and more, so log a summary.
    logDispatch(context, payload, {
      channels: payload.d.channels.length,
      id: payload.d.id,
      memberCount: payload.d.member_count,
      name: payload.d.name,
      roles: payload.d.roles.length,
      threads: payload.d.threads.length,
    });
  },
  [GatewayDispatchEvents.GuildUpdate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.GuildDelete]: (payload, context): void => {
    logDispatch(context, payload);
  },

  // Roles
  [GatewayDispatchEvents.GuildRoleCreate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.GuildRoleUpdate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.GuildRoleDelete]: (payload, context): void => {
    logDispatch(context, payload);
  },

  // Channels
  [GatewayDispatchEvents.ChannelCreate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.ChannelUpdate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.ChannelDelete]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.ChannelPinsUpdate]: (payload, context): void => {
    logDispatch(context, payload);
  },

  // Threads
  [GatewayDispatchEvents.ThreadCreate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.ThreadUpdate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.ThreadDelete]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.ThreadListSync]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.ThreadMemberUpdate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.ThreadMembersUpdate]: (payload, context): void => {
    logDispatch(context, payload);
  },

  // Stage instances
  [GatewayDispatchEvents.StageInstanceCreate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.StageInstanceUpdate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.StageInstanceDelete]: (payload, context): void => {
    logDispatch(context, payload);
  },

  // Voice channels
  [GatewayDispatchEvents.VoiceChannelStatusUpdate]: (payload, context): void => {
    logDispatch(context, payload);
  },
  [GatewayDispatchEvents.VoiceChannelStartTimeUpdate]: (payload, context): void => {
    logDispatch(context, payload);
  },
} satisfies DispatchHandlers;

export default guildsHandlers;
