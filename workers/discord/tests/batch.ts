import type { MappedQueueMessageBatch } from "@bachman-dev/workers-shared/cloudflare";
import {
  ComponentType,
  type DiscordEditMessageQueueBody,
  type DiscordMessageQueueBody,
} from "@bachman-dev/workers-shared/discord";
import { type QueueResult, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type MockInstance, vi } from "vitest";

import { getDrizzle } from "../src/db/index.ts";
import worker from "../src/index.ts";
import type { QueueBodyMap, QueueName } from "../src/types/cloudflare.ts";
import type { MessageRef } from "../src/util.ts";

let nextQueueMessageId = 0;

/** What happened to a batch run through the consumer. */
interface BatchRun {
  /** The queue message IDs, in delivery order. */
  ids: string[];
  /** Which messages were acked or retried. */
  result: QueueResult;
  /** Each message's `retry()`, in delivery order. */
  retries: MockInstance<Message["retry"]>[];
}

/**
 * Builds a text display component.
 *
 * @param {string} content - The text to show.
 * @returns {DiscordEditMessageQueueBody["component"]} The component.
 */
function text(content: string): DiscordEditMessageQueueBody["component"] {
  return { type: ComponentType.TextDisplay, content };
}

/**
 * Runs the queue consumer on one batch.
 *
 * @param {DiscordMessageQueueBody[]} bodies - The queued bodies, in delivery order.
 * @returns {Promise<BatchRun>} The queue message IDs, which messages were acked or retried, and how each was retried.
 */
async function runBatch(bodies: DiscordMessageQueueBody[]): Promise<BatchRun> {
  const messages = bodies.map((body) => {
    nextQueueMessageId += 1;
    return { id: `queue-message-${nextQueueMessageId}`, timestamp: new Date(), attempts: 1, body };
  });
  const batch = createMessageBatch<DiscordMessageQueueBody>("discord-message-queue", messages);
  const mapped: MappedQueueMessageBatch<QueueName, QueueBodyMap> = {
    queue: "discord-message-queue",
    messages: batch.messages,
    metadata: batch.metadata,
    ackAll: () => {
      batch.ackAll();
    },
    retryAll: (options) => {
      batch.retryAll(options);
    },
  };
  // Watch the retry calls themselves, since getQueueResult doesn't report retry delays
  const retries = batch.messages.map((message) => vi.spyOn(message, "retry"));
  const ctx = createExecutionContext();
  await worker.queue(mapped, env);
  return { ids: messages.map((message) => message.id), result: await getQueueResult(batch, ctx), retries };
}

/**
 * Reads a ref's row from `message_refs`.
 *
 * @param {string} ref - The ref.
 * @returns {Promise<MessageRef | undefined>} The row, if there is one.
 */
async function findRef(ref: string): Promise<MessageRef | undefined> {
  return await getDrizzle(env.DB).query.messageRefs.findFirst({ where: { ref: { eq: ref } } });
}

export { type BatchRun, findRef, runBatch, text };
