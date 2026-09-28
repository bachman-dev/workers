import type {
  RESTPostAPIChannelMessageJSONBody,
  RESTPostAPIWebhookWithTokenJSONBody,
  RESTPostAPIWebhookWithTokenQuery,
  Snowflake,
} from "discord-api-types/v10";

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
  /** Top-level components left out of `messages` because they are too large on their own. */
  errors: ComponentLimitError[];
}

/** A message a bot posts to a channel; the consumer authenticates as the bot looked up by `applicationId`. */
export interface DiscordChannelMessageQueueBody {
  format: "message";
  applicationId: Snowflake;
  channelId: Snowflake;
  body: MessageBodyByFormat["message"];
}

/** A message sent by executing a webhook. */
export interface DiscordWebhookMessageQueueBody {
  format: "webhook";
  webhookId: Snowflake;
  /** Query string options, e.g. `thread_id` or `with_components`. */
  query?: RESTPostAPIWebhookWithTokenQuery;
  body: MessageBodyByFormat["webhook"];
}

export type DiscordMessageQueueBody = DiscordChannelMessageQueueBody | DiscordWebhookMessageQueueBody;
