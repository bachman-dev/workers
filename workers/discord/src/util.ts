import {
  type DiscordCreateMessageQueueBody,
  type DiscordExecuteWebhookQueueBody,
  type MessageBodyByFormat,
  type REST,
  type RESTPostAPIWebhookWithTokenQuery,
  Routes,
  makeURLSearchParams,
} from "@bachman-dev/workers-shared/discord";

/** Discord rejects nonces longer than this. */
const MAX_NONCE_LENGTH = 25;

/**
 * Derives a stable nonce for a ref'd post, so Discord can drop a repeated Create Message for the same ref.
 *
 * @param {string} ref - The post's ref.
 * @returns {Promise<string>} The first 25 characters of the base64url SHA-256 digest of `ref`.
 */
export async function discordNonce(ref: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ref)));
  return btoa(String.fromCodePoint(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .slice(0, MAX_NONCE_LENGTH);
}

/**
 * Sends a message by executing a webhook.
 *
 * @param {REST} rest - The REST client; webhook executions don't use its token.
 * @param {DiscordExecuteWebhookQueueBody} destination - The queued body naming the webhook and query options.
 * @param {string} webhookToken - The webhook's token.
 * @param {MessageBodyByFormat["webhook"]} body - The message to send.
 * @returns {Promise<void>} Resolves once Discord accepts the message.
 */
export async function executeWebhook(
  rest: REST,
  destination: DiscordExecuteWebhookQueueBody,
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

/**
 * Sends a message to a channel as a bot.
 *
 * @param {REST} rest - The REST client, authenticated as the bot.
 * @param {DiscordCreateMessageQueueBody} destination - The queued body naming the channel.
 * @param {MessageBodyByFormat["message"]} body - The message to send.
 * @returns {Promise<void>} Resolves once Discord accepts the message.
 */
export async function sendMessage(
  rest: REST,
  destination: DiscordCreateMessageQueueBody,
  body: MessageBodyByFormat["message"],
): Promise<void> {
  await rest.post(Routes.channelMessages(destination.channelId), { body });
}
