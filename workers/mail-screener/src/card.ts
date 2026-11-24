import {
  type APIActionRowComponent,
  type APIAllowedMentions,
  type APIButtonComponentWithCustomId,
  type APIComponentInContainer,
  type APIContainerComponent,
  ButtonStyle,
  ComponentType,
  type DiscordCreateMessageQueueBody,
  type DiscordEditMessageQueueBody,
  SeparatorSpacingSize,
} from "@bachman-dev/workers-shared/discord";

import { isFreeMail, orgDomain } from "./decide.ts";
import { truncate } from "./mime.ts";
import type { Env } from "./types/cloudflare.ts";
import type { Dmarc, Review, ReviewAction, ReviewDecision, ReviewStatus } from "./types/screener.ts";

/** Discord's longest button label. */
const MAX_LABEL_LENGTH = 80;
/** The longest sender name a card shows. */
const MAX_NAME_LENGTH = 200;
const MS_PER_SECOND = 1000;

/** Cards never ping anyone, whatever the sender put in their name or subject. */
const NO_MENTIONS: APIAllowedMentions = { parse: [] };

const ACCENT_COLORS: Readonly<Record<ReviewStatus, number>> = {
  open: 0xf1c40f,
  allowed: 0x2ecc71,
  blocked: 0xe74c3c,
  dismissed: 0x95a5a6,
};

const DMARC_LABELS: Readonly<Record<Dmarc, string>> = {
  pass: "✅ pass",
  fail: "❌ fail",
  none: "➖ none",
};

/**
 * Shows untrusted text from a message as inline code, which Discord never turns into links, mentions or formatting.
 * Backticks become a lookalike so the text can't close the code span early.
 *
 * @param {string} text - Text from the message, e.g. its subject.
 * @returns {string} The text as inline code, or an em dash if it's empty.
 */
function code(text: string): string {
  const safe = text.replaceAll("`", "ˋ").replaceAll(/\s+/gv, " ").trim();
  return safe === "" ? "—" : `\`${safe}\``;
}

/**
 * Formats a time as a Discord timestamp, which each viewer sees in their own time zone.
 *
 * @param {number} time - Unix time in milliseconds.
 * @returns {string} The timestamp markup, shown relative to now.
 */
function timestamp(time: number): string {
  return `<t:${Math.floor(time / MS_PER_SECOND)}:R>`;
}

/**
 * Finds a reviewed sender's exact and parent domains.
 *
 * @param {Review} review - The review.
 * @returns {{ domain: string; org: string }} The host after the `@`, and its parent domain.
 */
function domainsOf(review: Review): { domain: string; org: string } {
  const domain = review.fromAddr.slice(review.fromAddr.lastIndexOf("@") + 1);
  return { domain, org: orgDomain(domain) };
}

/**
 * Says what a decision did, for the closed card.
 *
 * @param {ReviewDecision} decision - How the review was closed.
 * @param {Review} review - The review.
 * @returns {string} A short line, e.g. "Sender allowlisted".
 */
function outcomeText(decision: ReviewDecision, review: Review): string {
  const { domain, org } = domainsOf(review);
  switch (decision) {
    case "allow_sender":
      return "✅ Sender allowlisted";
    case "allow_domain":
      return `✅ ${code(domain)} allowlisted`;
    case "allow_org":
      return `✅ ${code(org)} and its subdomains allowlisted`;
    case "block_sender":
      return "⛔ Sender blocked";
    case "block_domain":
      return `⛔ ${code(domain)} blocked`;
    case "block_org":
      return `⛔ ${code(org)} and its subdomains blocked`;
    case "dismiss":
      return "🗑️ Dismissed";
    case "expire":
      return "⌛ Dismissed after 14 days without a decision";
  }
}

/**
 * Builds the ref a review's card is posted, edited and found by.
 *
 * @param {string} reviewId - The review's ID.
 * @returns {string} The ref.
 */
function cardRef(reviewId: string): string {
  return `mail-screener:review:${reviewId}`;
}

/**
 * Builds a review button's custom ID, which the bot parses to call decide().
 *
 * @param {ReviewAction} action - What the button does.
 * @param {string} reviewId - The review it answers.
 * @returns {string} The custom ID, `screen:<action>:<reviewId>`.
 */
function reviewCustomId(action: ReviewAction, reviewId: string): string {
  return `screen:${action}:${reviewId}`;
}

/**
 * Builds a button that answers a review.
 *
 * @param {ReviewAction} action - What the button does.
 * @param {string} reviewId - The review it answers.
 * @param {string} label - What it says.
 * @param {ButtonStyle.Success | ButtonStyle.Danger | ButtonStyle.Secondary} style - Its color.
 * @returns {APIButtonComponentWithCustomId} The button.
 */
function button(
  action: ReviewAction,
  reviewId: string,
  label: string,
  style: ButtonStyle.Success | ButtonStyle.Danger | ButtonStyle.Secondary,
): APIButtonComponentWithCustomId {
  return {
    type: ComponentType.Button,
    style,
    label: truncate(label, MAX_LABEL_LENGTH),
    custom_id: reviewCustomId(action, reviewId),
  };
}

/**
 * Builds the allow or block row. Domain buttons name the real domain; when the exact domain is the parent domain
 * there's one, which covers its subdomains too, and for free mail there are none.
 *
 * @param {"allow" | "block"} verb - Which row.
 * @param {Review} review - The review.
 * @returns {APIActionRowComponent<APIButtonComponentWithCustomId>} The row.
 */
function decisionRow(verb: "allow" | "block", review: Review): APIActionRowComponent<APIButtonComponentWithCustomId> {
  const { domain, org } = domainsOf(review);
  const style = verb === "allow" ? ButtonStyle.Success : ButtonStyle.Danger;
  const label = verb === "allow" ? "Allow" : "Block";
  const buttons = [button(`${verb}_sender`, review.id, `${label} sender`, style)];
  if (!isFreeMail({ domain, org })) {
    if (domain !== org) {
      buttons.push(button(`${verb}_domain`, review.id, `${label} ${domain}`, style));
    }
    buttons.push(button(`${verb}_org`, review.id, `${label} ${org}`, style));
  }
  return { type: ComponentType.ActionRow, components: buttons };
}

/**
 * Builds a review's card: one container with the sender, subject, DMARC result and message count, and the review
 * buttons while it's open. A closed card says what was decided instead. Nothing from the message body is shown.
 *
 * @param {Review} review - The review.
 * @returns {APIContainerComponent} The card.
 */
export function buildCard(review: Review): APIContainerComponent {
  const from =
    review.fromName === null
      ? code(review.fromAddr)
      : `${code(truncate(review.fromName, MAX_NAME_LENGTH))} ${code(review.fromAddr)}`;
  const messages = review.count === 1 ? "1 message" : `${review.count} messages`;
  const components: APIComponentInContainer[] = [
    {
      type: ComponentType.TextDisplay,
      content: [
        "### 📬 Mail from an unknown sender",
        `**From** ${from}`,
        `**Subject** ${code(review.subject)}`,
        `**DMARC** ${DMARC_LABELS[review.dmarc]}`,
        `**Received** ${messages}, first ${timestamp(review.receivedAt)}`,
      ].join("\n"),
    },
  ];
  if (review.status === "open" || review.decision === null) {
    components.push(
      { type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small },
      decisionRow("allow", review),
      decisionRow("block", review),
      {
        type: ComponentType.ActionRow,
        components: [button("dismiss", review.id, "Dismiss", ButtonStyle.Secondary)],
      },
    );
  } else {
    const decided = review.decidedAt === null ? "" : ` ${timestamp(review.decidedAt)}`;
    components.push({
      type: ComponentType.TextDisplay,
      content: `**${outcomeText(review.decision, review)}**${decided}`,
    });
  }
  return { type: ComponentType.Container, accent_color: ACCENT_COLORS[review.status], components };
}

/**
 * Builds the queued post of a new review's card.
 *
 * @param {Review} review - The new review.
 * @param {Env} env - The worker's bindings, which name the bot and channel.
 * @returns {DiscordCreateMessageQueueBody} The queued body, at the review's card version.
 */
export function cardPost(review: Review, env: Env): DiscordCreateMessageQueueBody {
  return {
    format: "message",
    applicationId: env.DISCORD_APP_ID,
    channelId: env.DISCORD_CHANNEL_ID,
    component: buildCard(review),
    allowedMentions: NO_MENTIONS,
    ref: cardRef(review.id),
    version: review.cardVersion,
  };
}

/**
 * Builds the queued edit that replaces a review's card with its current state.
 *
 * @param {Review} review - The review, with its card version already raised.
 * @returns {DiscordEditMessageQueueBody} The queued body, at the review's card version.
 */
export function cardEdit(review: Review): DiscordEditMessageQueueBody {
  return {
    op: "edit",
    ref: cardRef(review.id),
    version: review.cardVersion,
    component: buildCard(review),
    allowedMentions: NO_MENTIONS,
  };
}

export { cardRef, reviewCustomId };
