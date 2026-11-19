import type { MappedQueueMessageBatch } from "@bachman-dev/workers-shared/cloudflare";
import {
  ComponentType,
  type DiscordCreateMessageQueueBody,
  type DiscordDeleteMessageQueueBody,
  type DiscordEditMessageQueueBody,
  type DiscordExecuteWebhookQueueBody,
  type DiscordMessageQueueBody,
} from "@bachman-dev/workers-shared/discord";
import { type QueueResult, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type MockInstance, describe, expect, it, vi } from "vitest";

import { getDrizzle } from "../src/db/index.ts";
import worker from "../src/index.ts";
import type { QueueBodyMap, QueueName } from "../src/types/cloudflare.ts";
import { type MessageRef, discordNonce } from "../src/util.ts";
import { invalidFormBody, requests, respondTo, unknownMessage } from "./discord.ts";

const APPLICATION_ID = "100";
const WEBHOOK_ID = "200";
const CHANNEL_ID = "300";
const THREAD_ID = "400";
const REF = "test:ref:1";
const OTHER_REF = "test:ref:2";

let nextQueueMessageId = 0;

vi.setConfig({ testTimeout: 10_000 });

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
 * Builds a bot post to the test channel.
 *
 * @param {Partial<DiscordCreateMessageQueueBody>} overrides - Fields to set, e.g. `ref` and `version`.
 * @returns {DiscordCreateMessageQueueBody} The queued body.
 */
function botPost(overrides: Partial<DiscordCreateMessageQueueBody> = {}): DiscordCreateMessageQueueBody {
  return {
    format: "message",
    applicationId: APPLICATION_ID,
    channelId: CHANNEL_ID,
    component: text("post"),
    ...overrides,
  };
}

/**
 * Builds a webhook post through the test webhook.
 *
 * @param {Partial<DiscordExecuteWebhookQueueBody>} overrides - Fields to set, e.g. `ref` and `query`.
 * @returns {DiscordExecuteWebhookQueueBody} The queued body.
 */
function webhookPost(overrides: Partial<DiscordExecuteWebhookQueueBody> = {}): DiscordExecuteWebhookQueueBody {
  return { format: "webhook", webhookId: WEBHOOK_ID, component: text("post"), ...overrides };
}

/**
 * Builds an edit to a ref'd post.
 *
 * @param {string} ref - The post's ref.
 * @param {number} version - The edit's version.
 * @param {string} content - The new text.
 * @returns {DiscordEditMessageQueueBody} The queued body.
 */
function edit(ref: string, version: number, content: string): DiscordEditMessageQueueBody {
  return { op: "edit", ref, version, component: text(content) };
}

/**
 * Builds a delete of a ref'd post.
 *
 * @param {string} ref - The post's ref.
 * @param {number} version - The delete's version.
 * @returns {DiscordDeleteMessageQueueBody} The queued body.
 */
function remove(ref: string, version: number): DiscordDeleteMessageQueueBody {
  return { op: "delete", ref, version };
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

/**
 * Reads the Discord message ID saved for a ref.
 *
 * @param {string} ref - The ref.
 * @returns {Promise<string>} The message ID.
 */
async function messageIdOf(ref: string): Promise<string> {
  const row = await findRef(ref);
  if (row === undefined) {
    throw new Error(`No row for ${ref}`);
  }
  return row.messageId;
}

/**
 * Reads when a ref's message was marked deleted.
 *
 * @param {string} ref - The ref.
 * @returns {Promise<number | null | undefined>} The time, `null` if it wasn't, or `undefined` if there's no row.
 */
async function deletedAtOf(ref: string): Promise<number | null | undefined> {
  const row = await findRef(ref);
  return row?.deletedAt;
}

describe("ref'd posts", () => {
  it("saves the message a bot post created", async () => {
    expect.hasAssertions();
    respondTo("POST", () => Response.json({ id: "555", channel_id: CHANNEL_ID }));

    const { ids, result } = await runBatch([botPost({ ref: REF, version: 1 })]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: `/channels/${CHANNEL_ID}/messages`,
      body: { nonce: await discordNonce(REF), enforce_nonce: true, components: [text("post")] },
    });
    await expect(findRef(REF)).resolves.toMatchObject({
      format: "message",
      applicationId: APPLICATION_ID,
      webhookId: null,
      threadId: null,
      channelId: CHANNEL_ID,
      messageId: "555",
      version: 1,
      deletedAt: null,
    });
  });

  it("defaults the version to 0", async () => {
    expect.hasAssertions();

    await runBatch([botPost({ ref: REF })]);

    await expect(findRef(REF)).resolves.toMatchObject({ version: 0 });
  });

  it("waits for a webhook post and saves its thread", async () => {
    expect.hasAssertions();

    const { ids, result } = await runBatch([webhookPost({ ref: REF, query: { thread_id: THREAD_ID } })]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe(`/webhooks/${WEBHOOK_ID}/webhook-token`);
    expect(requests[0]?.query.get("wait")).toBe("true");
    expect(requests[0]?.query.get("thread_id")).toBe(THREAD_ID);
    await expect(findRef(REF)).resolves.toMatchObject({
      format: "webhook",
      applicationId: null,
      webhookId: WEBHOOK_ID,
      threadId: THREAD_ID,
      channelId: THREAD_ID,
    });
  });

  it("doesn't post again when it's delivered again", async () => {
    expect.hasAssertions();

    await runBatch([botPost({ ref: REF })]);
    const { ids, result } = await runBatch([botPost({ ref: REF })]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests).toHaveLength(1);
  });

  it("doesn't post twice when it's delivered twice in one batch", async () => {
    expect.hasAssertions();

    const { ids, result } = await runBatch([botPost({ ref: REF }), botPost({ ref: REF })]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ components: [text("post")] });
  });

  it("isn't bundled with an unref'd post to the same channel", async () => {
    expect.hasAssertions();

    const { ids, result } = await runBatch([
      botPost({ component: text("unref'd") }),
      botPost({ ref: REF, component: text("ref'd") }),
    ]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests.map((request) => request.body)).toStrictEqual([
      expect.objectContaining({ components: [text("unref'd")] }),
      expect.objectContaining({ components: [text("ref'd")], nonce: await discordNonce(REF) }),
    ]);
    expect(requests[0]?.body).not.toHaveProperty("nonce");
  });
});

describe("unref'd posts", () => {
  it("are still bundled into one message per destination", async () => {
    expect.hasAssertions();

    const { ids, result } = await runBatch([botPost({ component: text("one") }), botPost({ component: text("two") })]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ components: [text("one"), text("two")] });
  });
});

describe("edits and deletes", () => {
  it("retry when they arrive before their post", async () => {
    expect.hasAssertions();

    const { ids, result, retries } = await runBatch([edit(REF, 2, "edited")]);

    expect(result.explicitAcks).toStrictEqual([]);
    expect(result.retryMessages).toStrictEqual([{ msgId: ids[0] }]);
    expect(retries[0]).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(requests).toHaveLength(0);
  });

  it("apply after a post in the same batch, and skip a stale edit", async () => {
    expect.hasAssertions();

    const { ids, result } = await runBatch([
      botPost({ ref: REF, version: 1 }),
      edit(REF, 3, "three"),
      edit(REF, 2, "two"),
    ]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests.map((request) => request.method)).toStrictEqual(["POST", "PATCH"]);
    expect(requests[1]).toMatchObject({
      path: `/channels/${CHANNEL_ID}/messages/${await messageIdOf(REF)}`,
      body: { components: [text("three")] },
    });
    await expect(findRef(REF)).resolves.toMatchObject({ version: 3, deletedAt: null });
  });

  it("skip an edit no newer than the post", async () => {
    expect.hasAssertions();

    await runBatch([botPost({ ref: REF, version: 2 })]);
    const { ids, result } = await runBatch([edit(REF, 2, "same version")]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests).toHaveLength(1);
    await expect(findRef(REF)).resolves.toMatchObject({ version: 2 });
  });

  it("edit a webhook post in its thread", async () => {
    expect.hasAssertions();

    await runBatch([webhookPost({ ref: REF, query: { thread_id: THREAD_ID } })]);
    const { ids, result } = await runBatch([edit(REF, 1, "edited")]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests[1]).toMatchObject({
      method: "PATCH",
      path: `/webhooks/${WEBHOOK_ID}/webhook-token/messages/${await messageIdOf(REF)}`,
    });
    expect(requests[1]?.query.get("thread_id")).toBe(THREAD_ID);
    expect(requests[1]?.query.get("with_components")).toBe("true");
    await expect(findRef(REF)).resolves.toMatchObject({ version: 1 });
  });

  it("delete the message, then skip later edits", async () => {
    expect.hasAssertions();

    await runBatch([botPost({ ref: REF })]);
    const { ids, result } = await runBatch([remove(REF, 1), edit(REF, 2, "too late")]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests.map((request) => request.method)).toStrictEqual(["POST", "DELETE"]);
    await expect(findRef(REF)).resolves.toMatchObject({ version: 1 });
    await expect(deletedAtOf(REF)).resolves.toBeTypeOf("number");
  });

  it("mark the row deleted when Discord says the message is gone", async () => {
    expect.hasAssertions();

    await runBatch([botPost({ ref: REF })]);
    respondTo("PATCH", unknownMessage);
    const { ids, result } = await runBatch([edit(REF, 1, "edited")]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(result.retryMessages).toStrictEqual([]);
    await expect(findRef(REF)).resolves.toMatchObject({ version: 0 });
    await expect(deletedAtOf(REF)).resolves.toBeTypeOf("number");
  });

  it("retry only the change that failed", async () => {
    expect.hasAssertions();

    await runBatch([botPost({ ref: REF }), botPost({ ref: OTHER_REF })]);
    respondTo("PATCH", invalidFormBody, `/channels/${CHANNEL_ID}/messages/${await messageIdOf(REF)}`);
    const { ids, result } = await runBatch([edit(REF, 1, "fails"), edit(OTHER_REF, 1, "works")]);

    expect(result.retryMessages).toStrictEqual([{ msgId: ids[0] }]);
    expect(result.explicitAcks).toStrictEqual([ids[1]]);
    await expect(findRef(REF)).resolves.toMatchObject({ version: 0 });
    await expect(findRef(OTHER_REF)).resolves.toMatchObject({ version: 1 });
  });
});
