import {
  type DiscordChannelMessageQueueBody,
  type DiscordWebhookMessageQueueBody,
  type REST,
  type RESTPostAPIWebhookWithTokenQuery,
  Routes,
  makeURLSearchParams,
} from "@bachman-dev/workers-shared/discord";

export async function executeWebhook(
  rest: REST,
  message: DiscordWebhookMessageQueueBody,
  webhookToken: string,
): Promise<void> {
  const { body, query, webhookId } = message;
  await rest.post(Routes.webhook(webhookId, webhookToken), {
    auth: false,
    body,
    query: makeURLSearchParams({ ...query, with_components: true } satisfies RESTPostAPIWebhookWithTokenQuery),
  });
}

export async function sendMessage(rest: REST, message: DiscordChannelMessageQueueBody): Promise<void> {
  const { body, channelId } = message;
  await rest.post(Routes.channelMessages(channelId), { body });
}
