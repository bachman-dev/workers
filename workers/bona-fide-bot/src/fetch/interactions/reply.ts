import {
  type APIAllowedMentions,
  type APIInteraction,
  type APIInteractionResponseChannelMessageWithSource,
  InteractionResponseType,
  MessageFlags,
} from "@bachman-dev/workers-shared/discord";

import type { Env } from "../../types/cloudflare.ts";

/** Replies never ping anyone, whatever text they echo back. */
const NO_MENTIONS: APIAllowedMentions = { parse: [] };

/**
 * Finds who sent an interaction: the member in a server, or the user in a DM.
 *
 * @param {Pick<APIInteraction, "member" | "user">} interaction - The interaction.
 * @returns {string | undefined} Their user ID, or `undefined` if Discord sent neither.
 */
function senderId(interaction: Pick<APIInteraction, "member" | "user">): string | undefined {
  return interaction.member?.user.id ?? interaction.user?.id;
}

/**
 * Checks that the bot's owner sent an interaction; only they may decide reviews and edit the sender lists.
 *
 * @param {Pick<APIInteraction, "member" | "user">} interaction - The interaction.
 * @param {Env} env - The worker's bindings, which name the owner.
 * @returns {boolean} Whether the owner sent it.
 */
function isOwner(interaction: Pick<APIInteraction, "member" | "user">, env: Env): boolean {
  const userId = senderId(interaction);
  return userId !== undefined && userId === env.DISCORD_OWNER_ID;
}

/**
 * Builds a reply only the person who sent the interaction sees.
 *
 * @param {string} content - The reply's text.
 * @returns {APIInteractionResponseChannelMessageWithSource} The interaction response.
 */
function ephemeral(content: string): APIInteractionResponseChannelMessageWithSource {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content, flags: MessageFlags.Ephemeral, allowed_mentions: NO_MENTIONS },
  };
}

export { NO_MENTIONS, ephemeral, isOwner };
