import type { MappedExportedHandler } from "@bachman-dev/workers-shared/cloudflare";
import {
  type APIMessage,
  type DiscordMessageQueueBody,
  type DiscordSyncCommandsQueueBody,
  type MessageBodyByFormat,
  type MessageFormat,
  splitComponentsToMessages,
} from "@bachman-dev/workers-shared/discord";

import applyChange from "./changes.ts";
import { type BatchContext, DiscordClients } from "./clients.ts";
import syncCommands from "./commands.ts";
import { getDrizzle } from "./db/index.ts";
import { messageRefs } from "./db/schema.ts";
import type { QueueBodyMap, QueueName } from "./types/cloudflare.ts";
import type { DiscordChangeQueueBody, DiscordPostQueueBody } from "./types/queue.ts";
import { discordNonce, executeWebhook, sendMessage } from "./util.ts";

/** Who posted a ref'd message, as saved in `message_refs`. */
type MessageRefPoster = Pick<typeof messageRefs.$inferInsert, "applicationId" | "format" | "threadId" | "webhookId">;

/**
 * Tells posts apart from edits and deletes. Bodies queued before `op` existed have none, and are posts.
 *
 * @param {Message<DiscordMessageQueueBody>} message - A message from the batch.
 * @returns {boolean} Whether the message posts a new message.
 */
function isPost(message: Message<DiscordMessageQueueBody>): message is Message<DiscordPostQueueBody> {
  return message.body.op === undefined || message.body.op === "post";
}

/**
 * Tells edits and deletes apart from posts.
 *
 * @param {Message<DiscordMessageQueueBody>} message - A message from the batch.
 * @returns {boolean} Whether the message edits or deletes a ref'd post.
 */
function isChange(message: Message<DiscordMessageQueueBody>): message is Message<DiscordChangeQueueBody> {
  return message.body.op === "edit" || message.body.op === "delete";
}

/**
 * Tells command syncs apart from posts, edits and deletes.
 *
 * @param {Message<DiscordMessageQueueBody>} message - A message from the batch.
 * @returns {boolean} Whether the message syncs a worker's commands.
 */
function isSyncCommands(message: Message<DiscordMessageQueueBody>): message is Message<DiscordSyncCommandsQueueBody> {
  return message.body.op === "sync-commands";
}

/** Queued components bound for the same place with the same allowed mentions, which can share a message. */
interface ComponentGroup {
  /** The first queued body in the group; every body in it differs only by its component. */
  destination: DiscordPostQueueBody;
  messages: Message<DiscordPostQueueBody>[];
}

/**
 * Groups queued components by where they're sent and who they may ping, keeping each group in delivery order.
 *
 * @param {readonly Message<DiscordPostQueueBody>[]} messages - The batch's posts.
 * @returns {ComponentGroup[]} The groups, in the order their first message arrived.
 */
function groupByDestination(messages: readonly Message<DiscordPostQueueBody>[]): ComponentGroup[] {
  const groups = new Map<string, ComponentGroup>();
  for (const message of messages) {
    const { component: _component, ...destination } = message.body;
    const key = JSON.stringify(destination);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { destination: message.body, messages: [message] });
    } else {
      group.messages.push(message);
    }
  }
  return [...groups.values()];
}

/**
 * Bundles a group's components into as few messages as possible and sends them in order. Each queued message is acked
 * once the message holding its component is sent, so a failed send only retries components that weren't posted yet.
 *
 * @param {Format} format - Whether the group is sent as bot channel messages or webhook executions.
 * @param {ComponentGroup} group - The components to send.
 * @param {(body: MessageBodyByFormat[Format]) => Promise<unknown>} send - Sends one message body.
 * @param {unknown[]} rejectedMessages - Where to report components too large for any message.
 * @returns {Promise<void>} Resolves once every message is sent.
 */
async function sendGroup<Format extends MessageFormat>(
  format: Format,
  group: ComponentGroup,
  send: (body: MessageBodyByFormat[Format]) => Promise<unknown>,
  rejectedMessages: unknown[],
): Promise<void> {
  const { allowedMentions } = group.destination;
  const results = splitComponentsToMessages(
    format,
    group.messages.map((message) => message.body.component),
  );
  for (const error of results.errors) {
    const message = group.messages[error.index];
    // Acked since it's sent to the dead letter queue instead of being retried
    rejectedMessages.push({ error: "DISCORD_COMPONENT_TOO_BIG", reason: error.message, message });
    message?.ack();
  }
  for (const [index, body] of results.messages.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- Must be in order
    await send(allowedMentions === undefined ? body : { ...body, allowed_mentions: allowedMentions });
    for (const componentIndex of results.indices[index] ?? []) {
      group.messages[componentIndex]?.ack();
    }
  }
}

/**
 * Sends a group of components without a ref, bundled into as few messages as possible.
 *
 * @param {ComponentGroup} group - The components to send.
 * @param {BatchContext} context - The batch's clients and rejected messages.
 * @returns {Promise<void>} Resolves once every message is sent or rejected.
 */
async function sendUnrefGroup(group: ComponentGroup, context: BatchContext): Promise<void> {
  const { destination } = group;
  const { clients, rejectedMessages } = context;
  switch (destination.format) {
    case "message": {
      const rest = await clients.bot(destination.applicationId);
      if (rest === undefined) {
        for (const message of group.messages) {
          // Acked since it's sent to the dead letter queue instead of being retried
          rejectedMessages.push({ error: "DISCORD_APP_ID_NOT_FOUND", message });
          message.ack();
        }
      } else {
        await sendGroup("message", group, async (body) => await sendMessage(rest, destination, body), rejectedMessages);
      }
      break;
    }
    case "webhook": {
      const rest = clients.webhook();
      const webhookToken = await clients.webhookToken(destination.webhookId);
      if (webhookToken === undefined) {
        for (const message of group.messages) {
          // Acked since it's sent to the dead letter queue instead of being retried
          rejectedMessages.push({ error: "DISCORD_WEBHOOK_ID_NOT_FOUND", message });
          message.ack();
        }
      } else {
        await sendGroup(
          "webhook",
          group,
          async (body) => await executeWebhook(rest, destination, webhookToken, body),
          rejectedMessages,
        );
      }
    }
  }
}

/**
 * Builds the message body for a ref'd post, which always gets a message of its own. Rejects the queued message if its
 * component can't fit in any message.
 *
 * @param {Format} format - Whether the post is a bot channel message or a webhook execution.
 * @param {Message<DiscordPostQueueBody>} message - The queued post.
 * @param {unknown[]} rejectedMessages - Where to report a component too large for any message.
 * @returns {MessageBodyByFormat[Format] | undefined} The body, or `undefined` if the message was rejected.
 */
function refPostBody<Format extends MessageFormat>(
  format: Format,
  message: Message<DiscordPostQueueBody>,
  rejectedMessages: unknown[],
): MessageBodyByFormat[Format] | undefined {
  const results = splitComponentsToMessages(format, [message.body.component]);
  const [body] = results.messages;
  if (body === undefined) {
    // Acked since it's sent to the dead letter queue instead of being retried
    rejectedMessages.push({ error: "DISCORD_COMPONENT_TOO_BIG", reason: results.errors[0]?.message, message });
    message.ack();
    return undefined;
  }
  const { allowedMentions } = message.body;
  return allowedMentions === undefined ? body : { ...body, allowed_mentions: allowedMentions };
}

/**
 * Posts a ref'd component as its own message, unless the ref was already posted, and saves where it landed so later
 * edits and deletes can find it.
 *
 * @param {Message<DiscordPostQueueBody>} message - The queued post.
 * @param {string} ref - The post's ref.
 * @param {BatchContext} context - The batch's database, clients and rejected messages.
 * @returns {Promise<void>} Resolves once the message is posted and saved, skipped, or rejected.
 */
async function sendRefPost(message: Message<DiscordPostQueueBody>, ref: string, context: BatchContext): Promise<void> {
  const { body: queued } = message;
  const { clients, drizzle, rejectedMessages } = context;

  const existing = await drizzle.query.messageRefs.findFirst({ columns: { ref: true }, where: { ref: { eq: ref } } });
  if (existing !== undefined) {
    // Already posted, e.g. this is a redelivery
    message.ack();
    return;
  }

  let sent: APIMessage | undefined = undefined;
  let poster: MessageRefPoster;
  switch (queued.format) {
    case "message": {
      const rest = await clients.bot(queued.applicationId);
      if (rest === undefined) {
        // Acked since it's sent to the dead letter queue instead of being retried
        rejectedMessages.push({ error: "DISCORD_APP_ID_NOT_FOUND", message });
        message.ack();
        return;
      }
      const body = refPostBody("message", message, rejectedMessages);
      if (body === undefined) {
        return;
      }
      // Discord returns the first message instead of posting again if a resend lands within a few minutes
      sent = await sendMessage(rest, queued, { ...body, nonce: await discordNonce(ref), enforce_nonce: true });
      poster = { format: "message", applicationId: queued.applicationId };
      break;
    }
    case "webhook": {
      const webhookToken = await clients.webhookToken(queued.webhookId);
      if (webhookToken === undefined) {
        // Acked since it's sent to the dead letter queue instead of being retried
        rejectedMessages.push({ error: "DISCORD_WEBHOOK_ID_NOT_FOUND", message });
        message.ack();
        return;
      }
      const body = refPostBody("webhook", message, rejectedMessages);
      if (body === undefined) {
        return;
      }
      sent = await executeWebhook(clients.webhook(), queued, webhookToken, body);
      poster = { format: "webhook", webhookId: queued.webhookId, threadId: queued.query?.thread_id ?? null };
      break;
    }
  }
  if (sent === undefined) {
    throw new Error(`Discord didn't return the message posted for ref ${ref}`);
  }

  const now = Date.now();
  await drizzle
    .insert(messageRefs)
    .values({
      ref,
      ...poster,
      channelId: sent.channel_id,
      messageId: sent.id,
      version: queued.version ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  message.ack();
}

/**
 * Sends a batch's posts in order. Components without a ref that share a destination are bundled into as few messages as
 * possible; each ref'd post gets its own message.
 *
 * @param {readonly Message<DiscordPostQueueBody>[]} posts - The batch's posts.
 * @param {BatchContext} context - The batch's database, clients and rejected messages.
 * @returns {Promise<void>} Resolves once every post is sent, skipped, or rejected.
 */
async function sendPosts(posts: readonly Message<DiscordPostQueueBody>[], context: BatchContext): Promise<void> {
  for (const group of groupByDestination(posts)) {
    const { ref } = group.destination;
    if (ref === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- Must be in order
      await sendUnrefGroup(group, context);
    } else {
      // The ref is part of the group's key, so every message here shares it; only the first can post
      for (const message of group.messages) {
        // oxlint-disable-next-line no-await-in-loop -- Must be in order
        await sendRefPost(message, ref, context);
      }
    }
  }
}

export default {
  queue: async (batch, env): Promise<void> => {
    const drizzle = getDrizzle(env.DB);
    const context: BatchContext = { drizzle, clients: new DiscordClients(drizzle), rejectedMessages: [] };

    const posts: Message<DiscordPostQueueBody>[] = [];
    const changes: Message<DiscordChangeQueueBody>[] = [];
    const syncs: Message<DiscordSyncCommandsQueueBody>[] = [];
    for (const message of batch.messages) {
      if (isPost(message)) {
        posts.push(message);
      } else if (isChange(message)) {
        changes.push(message);
      } else if (isSyncCommands(message)) {
        syncs.push(message);
      } else {
        // Acked since it's sent to the dead letter queue instead of being retried
        context.rejectedMessages.push({ error: "DISCORD_QUEUE_OP_UNKNOWN", message });
        message.ack();
      }
    }

    // Rejected messages are already acked, so dead-letter them even if a later send fails and the batch is retried
    try {
      // Posts go first, so a post and an edit to it in the same batch land in order. A failed post retries the posts
      // that weren't acked, but only once the batch's edits, deletes and command syncs have had their turn.
      let postsFailed = false;
      let postError: unknown = undefined;
      try {
        await sendPosts(posts, context);
      } catch (error) {
        postsFailed = true;
        postError = error;
      }
      for (const message of changes) {
        // oxlint-disable-next-line no-await-in-loop -- Must be in order
        await applyChange(message, context);
      }
      // Command syncs go last, and each retries on its own, so they never hold up a batch's messages
      await syncCommands(syncs, context);
      if (postsFailed) {
        throw postError;
      }
    } finally {
      if (context.rejectedMessages.length > 0) {
        await env.DEAD_LETTER_QUEUE.sendBatch(
          context.rejectedMessages.map((message) => {
            return {
              body: message,
              contentType: "json",
            };
          }),
        );
      }
    }
  },
} satisfies MappedExportedHandler<QueueName, QueueBodyMap, Env>;
