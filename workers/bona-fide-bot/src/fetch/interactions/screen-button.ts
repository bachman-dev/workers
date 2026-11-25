import {
  type APIContainerComponent,
  type APIInteractionResponseChannelMessageWithSource,
  type APIInteractionResponseUpdateMessage,
  type APIMessageComponentInteraction,
  InteractionResponseType,
  MessageFlags,
} from "@bachman-dev/workers-shared/discord";
import { type ReviewAction, SCREENER_REVIEW_ACTIONS } from "@bachman-dev/workers-shared/screener";
import { log } from "@bachman-dev/workers-shared/util";

import type { Env } from "../../types/cloudflare.ts";
import { NO_MENTIONS, ephemeral, isOwner } from "./reply.ts";

/** The prefix of every review button's custom ID, `screen:<action>:<reviewId>`. */
const SCREEN_BUTTON_PREFIX = "screen:";

/** A review ID: a ULID, 26 characters of Crockford's base32. */
const REVIEW_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/v;

/** What a review button asks for. */
interface ReviewButton {
  action: ReviewAction;
  reviewId: string;
}

/**
 * Checks that a custom ID's action is one of the card's.
 *
 * @param {string} action - The action from the custom ID.
 * @returns {boolean} Whether it's a review action.
 */
function isReviewAction(action: string): action is ReviewAction {
  return SCREENER_REVIEW_ACTIONS.some((known) => known === action);
}

/**
 * Parses a review button's custom ID.
 *
 * @param {string} customId - The custom ID, `screen:<action>:<reviewId>`.
 * @returns {ReviewButton | null} The action and review ID, or `null` if the custom ID isn't a review button's.
 */
function parseCustomId(customId: string): ReviewButton | null {
  const [prefix, action, reviewId, ...rest] = customId.split(":");
  if (
    `${prefix}:` !== SCREEN_BUTTON_PREFIX ||
    action === undefined ||
    !isReviewAction(action) ||
    reviewId === undefined ||
    !REVIEW_ID.test(reviewId) ||
    rest.length > 0
  ) {
    return null;
  }
  return { action, reviewId };
}

/**
 * Answers a review card's button. Only the owner may press them. The card is updated in the same response, with the
 * closed card decide() returns; the edit decide() queued for the discord worker carries a higher version, so a later
 * count bump can't undo it, and the card isn't edited again through the interaction token.
 *
 * @param {APIMessageComponentInteraction} interaction - The button press.
 * @param {Env} env - The worker's bindings.
 * @returns {Promise<APIInteractionResponseChannelMessageWithSource | APIInteractionResponseUpdateMessage>} The updated
 *   card, or an ephemeral reply saying why nothing changed.
 */
export default async function handleScreenButton(
  interaction: APIMessageComponentInteraction,
  env: Env,
): Promise<APIInteractionResponseChannelMessageWithSource | APIInteractionResponseUpdateMessage> {
  if (!isOwner(interaction, env)) {
    return ephemeral("This isn't yours to decide.");
  }
  const button = parseCustomId(interaction.data.custom_id);
  if (button === null) {
    return ephemeral("Unknown button.");
  }
  if (env.SCREENER === undefined) {
    return ephemeral("The screener isn't available here.");
  }

  let card: APIContainerComponent | null;
  try {
    card = await env.SCREENER.decide(button.reviewId, button.action);
  } catch (error) {
    log("error", `Couldn't decide review ${button.reviewId} with ${button.action}`, error);
    return ephemeral("Couldn't record that. Try again in a moment.");
  }
  if (card === null) {
    return ephemeral("This review no longer exists.");
  }
  return {
    type: InteractionResponseType.UpdateMessage,
    // The card was posted with Components V2, which an update can set but never clear
    data: { components: [card], flags: MessageFlags.IsComponentsV2, allowed_mentions: NO_MENTIONS },
  };
}

export { SCREEN_BUTTON_PREFIX };
