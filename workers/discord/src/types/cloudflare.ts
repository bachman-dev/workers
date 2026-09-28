import type { DiscordMessageQueueBody } from "@bachman-dev/workers-shared/discord";

export type QueueName = "discord-message-queue";

export interface QueueBodyMap {
  "discord-message-queue": DiscordMessageQueueBody;
}
