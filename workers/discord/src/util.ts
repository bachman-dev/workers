import {
  type APIAllowedMentions,
  type APIMessage,
  type APIMessageTopLevelComponent,
  type DiscordCreateMessageQueueBody,
  type DiscordExecuteWebhookQueueBody,
  type MessageBodyByFormat,
  type MessageFlags,
  type REST,
  type RESTDeleteAPIWebhookWithTokenMessageQuery,
  type RESTPatchAPIChannelMessageJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageQuery,
  type RESTPostAPIWebhookWithTokenQuery,
  Routes,
  makeURLSearchParams,
} from "@bachman-dev/workers-shared/discord";

import type { messageRefs } from "./db/schema.ts";

/** Discord rejects nonces longer than this. */
const MAX_NONCE_LENGTH = 25;

/**
 * Checks that a Discord response is a message, so its IDs can be saved.
 *
 * @param {unknown} value - The parsed response body.
 * @returns {boolean} True if `value` has a message's `id` and `channel_id`.
 */
function isAPIMessage(value: unknown): value is APIMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "channel_id" in value &&
    typeof value.channel_id === "string"
  );
}

/**
 * Looks up the webhook token a webhook post needs, failing loudly if the caller didn't supply one.
 *
 * @param {MessageRef} messageRef - The ref'd post.
 * @param {string | undefined} webhookToken - The token of the webhook that posted it.
 * @returns {{ webhookId: string; webhookToken: string }} The webhook's ID and token.
 */
function requireWebhook(
  messageRef: MessageRef,
  webhookToken: string | undefined,
): { webhookId: string; webhookToken: string } {
  if (messageRef.webhookId === null || webhookToken === undefined) {
    throw new Error(`Message ref ${messageRef.ref} was posted by a webhook, but its webhook token wasn't given`);
  }
  return { webhookId: messageRef.webhookId, webhookToken };
}

/** A row of `message_refs`: where a ref'd post landed and how to reach it again. */
export type MessageRef = typeof messageRefs.$inferSelect;

/** The body of an edit to a ref'd post, which swaps in a new top-level component. */
export interface MessageEditBody {
  components: [APIMessageTopLevelComponent];
  flags: MessageFlags.IsComponentsV2;
  allowed_mentions?: APIAllowedMentions;
}

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
 * Sends a message by executing a webhook. A ref'd post waits for Discord to create the message, so its ID can be saved.
 *
 * @param {REST} rest - The REST client; webhook executions don't use its token.
 * @param {DiscordExecuteWebhookQueueBody} destination - The queued body naming the webhook and query options.
 * @param {string} webhookToken - The webhook's token.
 * @param {MessageBodyByFormat["webhook"]} body - The message to send.
 * @returns {Promise<APIMessage | undefined>} The created message for a ref'd post, or `undefined` if Discord wasn't
 *   asked to wait for it.
 */
export async function executeWebhook(
  rest: REST,
  destination: DiscordExecuteWebhookQueueBody,
  webhookToken: string,
  body: MessageBodyByFormat["webhook"],
): Promise<APIMessage | undefined> {
  const { query, ref, webhookId } = destination;
  const wait = ref !== undefined;
  const message = await rest.post(Routes.webhook(webhookId, webhookToken), {
    auth: false,
    body,
    query: makeURLSearchParams({
      ...query,
      with_components: true,
      ...(wait ? { wait } : {}),
    } satisfies RESTPostAPIWebhookWithTokenQuery),
  });
  if (!wait) {
    return undefined;
  }
  if (!isAPIMessage(message)) {
    throw new TypeError("Unexpected response from Execute Webhook");
  }
  return message;
}

/**
 * Sends a message to a channel as a bot.
 *
 * @param {REST} rest - The REST client, authenticated as the bot.
 * @param {DiscordCreateMessageQueueBody} destination - The queued body naming the channel.
 * @param {MessageBodyByFormat["message"]} body - The message to send.
 * @returns {Promise<APIMessage>} The created message.
 */
export async function sendMessage(
  rest: REST,
  destination: DiscordCreateMessageQueueBody,
  body: MessageBodyByFormat["message"],
): Promise<APIMessage> {
  const message = await rest.post(Routes.channelMessages(destination.channelId), { body });
  if (!isAPIMessage(message)) {
    throw new TypeError("Unexpected response from Create Message");
  }
  return message;
}

/**
 * Edits a ref'd post, as the bot or through the webhook that posted it.
 *
 * @param {REST} rest - For bot posts, the REST client authenticated as the bot; webhook edits don't use its token.
 * @param {MessageRef} messageRef - The ref'd post to edit.
 * @param {string | undefined} webhookToken - The webhook's token, for webhook posts.
 * @param {MessageEditBody} body - The new message contents.
 * @returns {Promise<void>} Resolves once Discord accepts the edit.
 */
export async function editMessage(
  rest: REST,
  messageRef: MessageRef,
  webhookToken: string | undefined,
  body: MessageEditBody,
): Promise<void> {
  if (messageRef.format === "message") {
    await rest.patch(Routes.channelMessage(messageRef.channelId, messageRef.messageId), {
      body: body satisfies RESTPatchAPIChannelMessageJSONBody,
    });
  } else {
    const webhook = requireWebhook(messageRef, webhookToken);
    await rest.patch(Routes.webhookMessage(webhook.webhookId, webhook.webhookToken, messageRef.messageId), {
      auth: false,
      body: body satisfies RESTPatchAPIWebhookWithTokenMessageJSONBody,
      query: makeURLSearchParams({
        ...(messageRef.threadId === null ? {} : { thread_id: messageRef.threadId }),
        with_components: true,
      } satisfies RESTPatchAPIWebhookWithTokenMessageQuery),
    });
  }
}

/**
 * Deletes a ref'd post, as the bot or through the webhook that posted it.
 *
 * @param {REST} rest - For bot posts, the REST client authenticated as the bot; webhook deletes don't use its token.
 * @param {MessageRef} messageRef - The ref'd post to delete.
 * @param {string | undefined} webhookToken - The webhook's token, for webhook posts.
 * @returns {Promise<void>} Resolves once Discord deletes the message.
 */
export async function deleteMessage(
  rest: REST,
  messageRef: MessageRef,
  webhookToken: string | undefined,
): Promise<void> {
  if (messageRef.format === "message") {
    await rest.delete(Routes.channelMessage(messageRef.channelId, messageRef.messageId));
  } else {
    const webhook = requireWebhook(messageRef, webhookToken);
    const query: RESTDeleteAPIWebhookWithTokenMessageQuery =
      messageRef.threadId === null ? {} : { thread_id: messageRef.threadId };
    await rest.delete(Routes.webhookMessage(webhook.webhookId, webhook.webhookToken, messageRef.messageId), {
      auth: false,
      query: makeURLSearchParams(query),
    });
  }
}
