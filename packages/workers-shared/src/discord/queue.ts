import type {
  APIAllowedMentions,
  APIMessageTopLevelComponent,
  RESTPostAPIApplicationCommandsJSONBody,
  RESTPostAPIChannelMessageJSONBody,
  RESTPostAPIWebhookWithTokenJSONBody,
  RESTPostAPIWebhookWithTokenQuery,
  Snowflake,
} from "discord-api-types/v10";

import type { DiscordCommandScope } from "./interactions.ts";
import type { ComponentLimitError } from "./util.ts";

/** Request body type for each way of sending a message. */
export interface MessageBodyByFormat {
  /** Create Message, sent by a bot. */
  message: RESTPostAPIChannelMessageJSONBody;
  /** Execute Webhook. */
  webhook: RESTPostAPIWebhookWithTokenJSONBody;
}

export type MessageFormat = keyof MessageBodyByFormat;

export interface SplitComponentsResult<Format extends MessageFormat> {
  /** Message bodies to send in order; each stays within the total component limit. */
  messages: MessageBodyByFormat[Format][];
  /** For each message in `messages`, the positions of its components in the array that was split. */
  indices: number[][];
  /** Top-level components left out of `messages` because they are too large on their own. */
  errors: ComponentLimitError[];
}

/**
 * One top-level component to send. The consumer bundles queued components that share a destination and allowed mentions
 * into as few messages as possible.
 */
export interface DiscordQueuedComponent {
  component: APIMessageTopLevelComponent;
  /** Who the message may ping; Discord parses every mention in the text if this is left out. */
  allowedMentions?: APIAllowedMentions;
  /**
   * Names the post so it can be edited or deleted later with an `edit` or `delete` body carrying the same ref. A ref'd
   * post always gets its own message, and is posted only once even if it's delivered again.
   */
  ref?: string;
  /** Starting version for a ref'd post; later edits and deletes must carry a higher one. Defaults to 0. */
  version?: number;
}

/** A component a bot posts to a channel; the consumer authenticates as the bot looked up by `applicationId`. */
export interface DiscordCreateMessageQueueBody extends DiscordQueuedComponent {
  op?: "post";
  format: "message";
  applicationId: Snowflake;
  channelId: Snowflake;
}

/** A component sent by executing a webhook. */
export interface DiscordExecuteWebhookQueueBody extends DiscordQueuedComponent {
  op?: "post";
  format: "webhook";
  webhookId: Snowflake;
  /** Query string options, e.g. `thread_id` or `with_components`. */
  query?: RESTPostAPIWebhookWithTokenQuery;
}

/** Replaces the component of the message posted with the same `ref`. */
export interface DiscordEditMessageQueueBody {
  op: "edit";
  ref: string;
  /** Must be higher than every earlier post or edit for this ref; an edit that's older than the message is skipped. */
  version: number;
  component: APIMessageTopLevelComponent;
  /** Who the edited message may ping; Discord parses every mention in the text if this is left out. */
  allowedMentions?: APIAllowedMentions;
}

/** Deletes the message posted with the same `ref`. */
export interface DiscordDeleteMessageQueueBody {
  op: "delete";
  ref: string;
  /** Must be higher than every earlier post or edit for this ref; an older delete is skipped. */
  version: number;
}

/** One command a worker has, and where it's registered. */
export interface DiscordSyncedCommand {
  scope: DiscordCommandScope;
  data: RESTPostAPIApplicationCommandsJSONBody;
}

/**
 * Every command a worker has for one application, global and guild; an empty list means it has none. The discord worker
 * bulk overwrites the global scope and each guild its `command_guilds` table names for the worker, skipping any scope
 * whose commands are unchanged since the last sync. A scope that gets no commands is cleared, including global commands
 * or guild commands registered before the worker first synced.
 */
export interface DiscordSyncCommandsQueueBody {
  op: "sync-commands";
  applicationId: Snowflake;
  /** The worker that owns this application's commands, e.g. `bona-fide-bot`; one worker owns each application's. */
  worker: string;
  commands: DiscordSyncedCommand[];
  /** Never set; declared so code that reads `ref` or `version` off any queued body still type-checks. */
  ref?: never;
  /** Never set; declared so code that reads `ref` or `version` off any queued body still type-checks. */
  version?: never;
}

export type DiscordMessageQueueBody =
  | DiscordCreateMessageQueueBody
  | DiscordExecuteWebhookQueueBody
  | DiscordEditMessageQueueBody
  | DiscordDeleteMessageQueueBody
  | DiscordSyncCommandsQueueBody;
