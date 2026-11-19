import type { MappedExportedHandler } from "@bachman-dev/workers-shared/cloudflare";
import {
  APIVersion,
  type DiscordCreateMessageQueueBody,
  type DiscordExecuteWebhookQueueBody,
  type DiscordMessageQueueBody,
  type MessageBodyByFormat,
  type MessageFormat,
  REST,
  splitComponentsToMessages,
} from "@bachman-dev/workers-shared/discord";

import { getDrizzle } from "./db/index.ts";
import type { QueueBodyMap, QueueName } from "./types/cloudflare.ts";
import { executeWebhook, sendMessage } from "./util.ts";

/** A queued body that posts a new message. */
type DiscordPostQueueBody = DiscordCreateMessageQueueBody | DiscordExecuteWebhookQueueBody;

/**
 * Tells posts apart from edits and deletes. Bodies queued before `op` existed have none, and are posts.
 *
 * @param {Message<DiscordMessageQueueBody>} message - A message from the batch.
 * @returns {boolean} Whether the message posts a new message.
 */
function isPost(message: Message<DiscordMessageQueueBody>): message is Message<DiscordPostQueueBody> {
  return message.body.op === undefined || message.body.op === "post";
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

export default {
  queue: async (batch, env): Promise<void> => {
    const restMap = new Map<string, REST>();
    const webhookTokenMap = new Map<string, string>();
    const drizzle = getDrizzle(env.DB);

    const rejectedMessages: unknown[] = [];

    const posts: Message<DiscordPostQueueBody>[] = [];
    for (const message of batch.messages) {
      if (isPost(message)) {
        posts.push(message);
      } else {
        // Edits and deletes aren't handled yet, so leave them on the queue
        message.retry();
      }
    }

    // Rejected messages are already acked, so dead-letter them even if a later send fails and the batch is retried
    try {
      for (const group of groupByDestination(posts)) {
        const { destination } = group;
        switch (destination.format) {
          case "message": {
            let rest = restMap.get(destination.applicationId);
            if (typeof rest === "undefined") {
              // oxlint-disable-next-line no-await-in-loop -- Must be in order
              const app = await drizzle.query.apps.findFirst({
                where: {
                  id: {
                    eq: destination.applicationId,
                  },
                },
              });
              if (typeof app !== "undefined") {
                rest = new REST({ version: APIVersion });
                rest.setToken(app.token);
                restMap.set(destination.applicationId, rest);
              }
            }
            if (typeof rest === "undefined") {
              for (const message of group.messages) {
                // Acked since it's sent to the dead letter queue instead of being retried
                rejectedMessages.push({ error: "DISCORD_APP_ID_NOT_FOUND", message });
                message.ack();
              }
            } else {
              // oxlint-disable-next-line no-await-in-loop -- Must be in order
              await sendGroup(
                "message",
                group,
                async (body) => await sendMessage(rest, destination, body),
                rejectedMessages,
              );
            }
            break;
          }
          case "webhook": {
            let rest = restMap.get("webhook");
            if (typeof rest === "undefined") {
              rest = new REST({ version: APIVersion });
              restMap.set("webhook", rest);
            }
            let webhookToken = webhookTokenMap.get(destination.webhookId);
            if (typeof webhookToken === "undefined") {
              // oxlint-disable-next-line no-await-in-loop -- Must be in order
              const webhook = await drizzle.query.webhooks.findFirst({
                where: {
                  id: {
                    eq: destination.webhookId,
                  },
                },
              });
              if (typeof webhook !== "undefined") {
                webhookToken = webhook.token;
                webhookTokenMap.set(destination.webhookId, webhook.token);
              }
            }
            if (typeof webhookToken === "undefined") {
              for (const message of group.messages) {
                // Acked since it's sent to the dead letter queue instead of being retried
                rejectedMessages.push({ error: "DISCORD_WEBHOOK_ID_NOT_FOUND", message });
                message.ack();
              }
            } else {
              // oxlint-disable-next-line no-await-in-loop -- Must be in order
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
    } finally {
      if (rejectedMessages.length > 0) {
        await env.DEAD_LETTER_QUEUE.sendBatch(
          rejectedMessages.map((message) => {
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
