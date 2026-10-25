import {
  type APIComponentInContainer,
  type APIContainerComponent,
  type APITextDisplayComponent,
  ButtonStyle,
  ComponentType,
  SeparatorSpacingSize,
} from "@bachman-dev/workers-shared/discord";

import { escapeMarkdown, linkLabel, truncate } from "./markdown.ts";

const MAX_TITLE_LENGTH = 200;
const MAX_LINK_LABEL_LENGTH = 200;
// Discord limits button labels to 80 characters
const MAX_BUTTON_LABEL_LENGTH = 80;

/**
 * Builds a masked markdown link, or just the escaped label if there is no URL.
 *
 * @param {string} label - Plain-text label, e.g. an issue title.
 * @param {string | null | undefined} url - Where the link goes.
 * @returns {string} A markdown link.
 */
function markdownLink(label: string, url: string | null | undefined): string {
  const shortened = truncate(label, MAX_LINK_LABEL_LENGTH);
  return typeof url === "string" && url !== "" ? `[${linkLabel(shortened)}](${url})` : escapeMarkdown(shortened);
}

/**
 * Builds a markdown link to a GitHub user's profile.
 *
 * @param {GithubUser} user - The user to link to.
 * @returns {string} A markdown link.
 */
function userLink(user: GithubUser): string {
  return markdownLink(user.login, user.html_url ?? `https://github.com/${user.login}`);
}

function textDisplay(content: string): APITextDisplayComponent {
  return { type: ComponentType.TextDisplay, content };
}

function header(message: GithubMessage): APIComponentInContainer[] {
  const { sender } = message;
  const texts = [`### ${escapeMarkdown(truncate(message.title, MAX_TITLE_LENGTH))}`];
  if (message.subject !== undefined) {
    texts.push(message.subject);
  }
  if (sender !== null && sender !== undefined) {
    texts.push(`-# by ${userLink(sender)}`);
  }
  const content = texts.map((text) => textDisplay(text));
  if (sender === null || sender === undefined || typeof sender.avatar_url !== "string") {
    return content;
  }
  return [
    {
      type: ComponentType.Section,
      components: content,
      accessory: { type: ComponentType.Thumbnail, media: { url: sender.avatar_url } },
    },
  ];
}

/** Container accent colors, one per message status. */
export const AccentColor = {
  /** Something failed, was removed, or was deleted. */
  Failure: 0xda3633,
  /** Something needs attention; these messages also mention the configured Discord user. */
  Attention: 0xe3b341,
  /** Something succeeded or was completed. */
  Success: 0x2ea043,
  /** General activity, mostly comments. */
  Info: 0x388bfd,
  /** Something is a draft, was unpublished, or was otherwise set aside. */
  Draft: 0x6e7681,
} as const;
export type MessageStatus = keyof typeof AccentColor;

/** The parts of a GitHub user, e.g. the event's sender, needed to show them in a message. */
export interface GithubUser {
  login: string;
  html_url?: string;
  avatar_url?: string;
}

/** The parts of a GitHub repository needed to show it in a message. */
export interface GithubRepository {
  full_name: string;
  html_url: string;
}

/** A link button shown at the bottom of a message, e.g. to view an issue on GitHub. */
export interface MessageLink {
  label: string;
  url: string;
}

export interface GithubMessage {
  status: MessageStatus;
  /** Short plain-text summary of what happened, shown as a heading, e.g. "Issue opened". */
  title: string;
  /** Markdown line naming what the event is about, e.g. a link to the issue; see {@link markdownLink}. */
  subject?: string | undefined;
  /** The user who triggered the event, shown with their avatar. */
  sender?: GithubUser | null | undefined;
  /** Extra markdown sections, e.g. a comment body; each becomes its own text display. */
  body?: (string | undefined)[] | undefined;
  /** Short markdown details shown in the footer next to the repository, e.g. a branch name. */
  details?: (string | undefined)[] | undefined;
  repository?: GithubRepository | undefined;
  /** Where to view the event on GitHub or elsewhere; omitted if there is no such page. */
  link?: MessageLink | undefined;
}

export interface MessageContext {
  /** Discord user ID mentioned in messages that need attention. */
  mentionId: string;
}

/**
 * Builds a Discord Components V2 container for a GitHub event: a heading with the sender's avatar, optional body
 * sections, and a footer with the repository and a link button. Messages that need attention mention the configured
 * user.
 *
 * @param {GithubMessage} message - What to show.
 * @param {MessageContext} context - Settings shared by every message.
 * @returns {APIContainerComponent} The container to send.
 */
export function buildGithubMessage(message: GithubMessage, context: MessageContext): APIContainerComponent {
  const components: APIComponentInContainer[] = [];
  if (message.status === "Attention") {
    components.push(textDisplay(`<@${context.mentionId}>`));
  }
  components.push(...header(message));

  const body = message.body?.filter((section): section is string => section !== undefined && section !== "") ?? [];
  if (body.length > 0) {
    components.push(
      { type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small },
      ...body.map((section) => textDisplay(section)),
    );
  }

  const footer = [
    message.repository === undefined
      ? undefined
      : markdownLink(message.repository.full_name, message.repository.html_url),
    ...(message.details ?? []),
  ].filter((detail) => detail !== undefined && detail !== "");
  if (footer.length > 0 || message.link !== undefined) {
    const footerText = textDisplay(`-# ${footer.length > 0 ? footer.join(" · ") : "GitHub"}`);
    components.push(
      message.link === undefined
        ? footerText
        : {
            type: ComponentType.Section,
            components: [footerText],
            accessory: {
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: truncate(message.link.label, MAX_BUTTON_LABEL_LENGTH),
              url: message.link.url,
            },
          },
    );
  }

  return { type: ComponentType.Container, accent_color: AccentColor[message.status], components };
}

export { markdownLink, userLink };
