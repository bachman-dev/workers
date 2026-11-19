import {
  MessageFlags,
  type REST,
  RESTJSONErrorCodes,
  splitComponentsToMessages,
} from "@bachman-dev/workers-shared/discord";
import { log } from "@bachman-dev/workers-shared/util";
import { and, eq, lt } from "drizzle-orm";

import type { BatchContext } from "./clients.ts";
import type { Drizzle } from "./db/index.ts";
import { messageRefs } from "./db/schema.ts";
import type { DiscordChangeQueueBody } from "./types/queue.ts";
import { type MessageRef, deleteMessage, editMessage } from "./util.ts";

/** How long an edit or delete waits for its post to be saved before it's tried again. */
const REF_NOT_FOUND_RETRY_DELAY_SECONDS = 15;

/** How to reach a ref'd post: the client to send with, and the webhook's token for webhook posts. */
interface MessageRefClient {
  rest: REST;
  webhookToken: string | undefined;
}

/**
 * Checks whether a Discord REST error says the message no longer exists, e.g. because someone deleted it by hand.
 *
 * @param {unknown} error - The error thrown by the REST client.
 * @returns {boolean} True for Discord's Unknown Message error.
 */
function isUnknownMessageError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === RESTJSONErrorCodes.UnknownMessage
  );
}

/**
 * Finds the client that can edit or delete a ref'd post. Rejects the queued message if the bot or webhook that posted
 * it is gone.
 *
 * @param {Message<DiscordChangeQueueBody>} message - The queued edit or delete.
 * @param {MessageRef} messageRef - The ref'd post.
 * @param {BatchContext} context - The batch's clients and rejected messages.
 * @returns {Promise<MessageRefClient | undefined>} The client, or `undefined` if the message was rejected.
 */
async function getMessageRefClient(
  message: Message<DiscordChangeQueueBody>,
  messageRef: MessageRef,
  context: BatchContext,
): Promise<MessageRefClient | undefined> {
  if (messageRef.format === "message") {
    const rest = messageRef.applicationId === null ? undefined : await context.clients.bot(messageRef.applicationId);
    if (rest !== undefined) {
      return { rest, webhookToken: undefined };
    }
    // Acked since it's sent to the dead letter queue instead of being retried
    context.rejectedMessages.push({ error: "DISCORD_APP_ID_NOT_FOUND", message });
  } else {
    const webhookToken =
      messageRef.webhookId === null ? undefined : await context.clients.webhookToken(messageRef.webhookId);
    if (webhookToken !== undefined) {
      return { rest: context.clients.webhook(), webhookToken };
    }
    // Acked since it's sent to the dead letter queue instead of being retried
    context.rejectedMessages.push({ error: "DISCORD_WEBHOOK_ID_NOT_FOUND", message });
  }
  message.ack();
  return undefined;
}

/**
 * Applies a queued edit or delete to its ref'd post, then records the new version. Throws if Discord or D1 fail.
 *
 * @param {Message<DiscordChangeQueueBody>} message - The queued edit or delete.
 * @param {BatchContext} context - The batch's database, clients and rejected messages.
 * @returns {Promise<void>} Resolves once the message is acked or set to retry.
 */
async function applyChangeOrThrow(message: Message<DiscordChangeQueueBody>, context: BatchContext): Promise<void> {
  const { body } = message;
  const { drizzle } = context;
  const messageRef = await drizzle.query.messageRefs.findFirst({ where: { ref: { eq: body.ref } } });
  if (messageRef === undefined) {
    // The post hasn't been saved yet, so wait for it
    message.retry({ delaySeconds: REF_NOT_FOUND_RETRY_DELAY_SECONDS });
    return;
  }
  if (messageRef.deletedAt !== null || body.version <= messageRef.version) {
    // The message is gone, or a newer post, edit or delete already landed
    message.ack();
    return;
  }

  const client = await getMessageRefClient(message, messageRef, context);
  if (client === undefined) {
    return;
  }

  // Only update the row if no newer change got there first
  const isNewer = and(eq(messageRefs.ref, body.ref), lt(messageRefs.version, body.version));
  const now = Date.now();
  if (body.op === "edit") {
    const [error] = splitComponentsToMessages(messageRef.format, [body.component]).errors;
    if (error !== undefined) {
      // Acked since it's sent to the dead letter queue instead of being retried
      context.rejectedMessages.push({ error: "DISCORD_COMPONENT_TOO_BIG", reason: error.message, message });
      message.ack();
      return;
    }
    await editMessage(client.rest, messageRef, client.webhookToken, {
      components: [body.component],
      flags: MessageFlags.IsComponentsV2,
      ...(body.allowedMentions === undefined ? {} : { allowed_mentions: body.allowedMentions }),
    });
    await drizzle.update(messageRefs).set({ version: body.version, updatedAt: now }).where(isNewer);
  } else {
    await deleteMessage(client.rest, messageRef, client.webhookToken);
    await drizzle.update(messageRefs).set({ version: body.version, updatedAt: now, deletedAt: now }).where(isNewer);
  }
  message.ack();
}

/**
 * Records that a ref'd post no longer exists on Discord, so later edits and deletes for it are skipped.
 *
 * @param {Drizzle} drizzle - The database.
 * @param {string} ref - The post's ref.
 * @returns {Promise<boolean>} Whether the row was updated.
 */
async function markDeleted(drizzle: Drizzle, ref: string): Promise<boolean> {
  try {
    const now = Date.now();
    await drizzle.update(messageRefs).set({ updatedAt: now, deletedAt: now }).where(eq(messageRefs.ref, ref));
    return true;
  } catch (error) {
    log("error", `Couldn't mark message ref ${ref} as deleted`, error);
    return false;
  }
}

/**
 * Applies a queued edit or delete to its ref'd post. Never throws: a failure retries this message only, so one bad
 * change doesn't hold up the rest of the batch.
 *
 * @param {Message<DiscordChangeQueueBody>} message - The queued edit or delete.
 * @param {BatchContext} context - The batch's database, clients and rejected messages.
 * @returns {Promise<void>} Resolves once the message is acked or set to retry.
 */
export default async function applyChange(
  message: Message<DiscordChangeQueueBody>,
  context: BatchContext,
): Promise<void> {
  try {
    await applyChangeOrThrow(message, context);
  } catch (error) {
    if (isUnknownMessageError(error) && (await markDeleted(context.drizzle, message.body.ref))) {
      message.ack();
    } else {
      log("error", `Couldn't ${message.body.op} message ref ${message.body.ref}`, error);
      message.retry();
    }
  }
}
