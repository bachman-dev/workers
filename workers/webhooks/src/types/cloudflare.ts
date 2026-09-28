import type { DiscordMessageQueueBody } from "@bachman-dev/workers-shared/discord";

export interface Env extends Cloudflare.Env {
  DISCORD_QUEUE: Queue<DiscordMessageQueueBody>;
  GITHUB_QUEUE: Queue<GithubWebhookQueueBody>;
}

export type QueueName = "discord-message-queue" | "github-webhook-queue";

export interface QueueBodyMap {
  "discord-message-queue": DiscordMessageQueueBody;
  "github-webhook-queue": GithubWebhookQueueBody;
}

export interface GithubWebhookQueueBody {
  deliveryId: string;
}
