import {
  type DiscordChannelMessageQueueBody,
  type DiscordWebhookMessageQueueBody,
  type MessageBodyByFormat,
  type REST,
  type RESTPostAPIWebhookWithTokenQuery,
  Routes,
  makeURLSearchParams,
} from "@bachman-dev/workers-shared/discord";

export async function executeWebhook(
  rest: REST,
  destination: DiscordWebhookMessageQueueBody,
  webhookToken: string,
  body: MessageBodyByFormat["webhook"],
): Promise<void> {
  const { query, webhookId } = destination;
  await rest.post(Routes.webhook(webhookId, webhookToken), {
    auth: false,
    body,
    query: makeURLSearchParams({ ...query, with_components: true } satisfies RESTPostAPIWebhookWithTokenQuery),
  });
}

export async function sendMessage(
  rest: REST,
  destination: DiscordChannelMessageQueueBody,
  body: MessageBodyByFormat["message"],
): Promise<void> {
  await rest.post(Routes.channelMessages(destination.channelId), { body });
}
