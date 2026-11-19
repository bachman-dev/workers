import type {
  DiscordCreateMessageQueueBody,
  DiscordDeleteMessageQueueBody,
  DiscordEditMessageQueueBody,
  DiscordExecuteWebhookQueueBody,
} from "@bachman-dev/workers-shared/discord";

/** A queued body that posts a new message. */
export type DiscordPostQueueBody = DiscordCreateMessageQueueBody | DiscordExecuteWebhookQueueBody;

/** A queued body that edits or deletes a ref'd post. */
export type DiscordChangeQueueBody = DiscordEditMessageQueueBody | DiscordDeleteMessageQueueBody;
