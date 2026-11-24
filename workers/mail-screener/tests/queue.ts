import type { DiscordMessageQueueBody } from "@bachman-dev/workers-shared/discord";
import { vi } from "vitest";

import { testEnv } from "./env.ts";

const METADATA: QueueSendMetadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };

/**
 * Captures what the worker and the Screener queue for the discord worker, instead of sending it. The Screener shares
 * the test bindings, so spying on them catches its sends too.
 *
 * @returns {DiscordMessageQueueBody[]} The queued bodies, in the order they're sent.
 */
export function captureQueue(): DiscordMessageQueueBody[] {
  const sent: DiscordMessageQueueBody[] = [];
  vi.spyOn(testEnv.DISCORD_QUEUE, "send").mockImplementation(async (body) => {
    sent.push(body);
    return await Promise.resolve({ metadata: METADATA });
  });
  vi.spyOn(testEnv.DISCORD_QUEUE, "sendBatch").mockImplementation(async (messages) => {
    for (const message of messages) {
      sent.push(message.body);
    }
    return await Promise.resolve({ metadata: METADATA });
  });
  return sent;
}

/** Makes every queue send fail, as if the queue were down. */
export function failQueue(): void {
  vi.spyOn(testEnv.DISCORD_QUEUE, "send").mockRejectedValue(new Error("Queue is down"));
  vi.spyOn(testEnv.DISCORD_QUEUE, "sendBatch").mockRejectedValue(new Error("Queue is down"));
}
