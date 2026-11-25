import type { DiscordMessageQueueBody } from "@bachman-dev/workers-shared/discord";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { queueCommandSync } from "../src/commands/sync.ts";
import worker from "../src/index.ts";
import { APP_ID, envWith, makeSigningKeys } from "./interactions.ts";

vi.setConfig({ testTimeout: 10_000 });

const keys = await makeSigningKeys();
const METADATA: QueueSendMetadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };

/**
 * Captures what's sent to the discord worker's queue, instead of sending it.
 *
 * @param {ReturnType<typeof envWith>} bindings - The bindings whose queue to watch.
 * @returns {DiscordMessageQueueBody[]} The bodies, in the order they're sent.
 */
function captureQueue(bindings: ReturnType<typeof envWith>): DiscordMessageQueueBody[] {
  const sent: DiscordMessageQueueBody[] = [];
  vi.spyOn(bindings.DISCORD_QUEUE, "send").mockImplementation(async (body) => {
    sent.push(body);
    return await Promise.resolve({ metadata: METADATA });
  });
  return sent;
}

describe("command sync", () => {
  it("queues one sync of every command, with /screen as a guild command", async () => {
    expect.hasAssertions();
    const bindings = envWith(keys);
    const sent = captureQueue(bindings);

    await queueCommandSync(bindings);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      op: "sync-commands",
      applicationId: APP_ID,
      worker: "bona-fide-bot",
      commands: [
        {
          scope: "guild",
          data: {
            name: "screen",
            default_member_permissions: "0",
            options: [{ name: "allow" }, { name: "deny" }, { name: "remove" }, { name: "list" }],
          },
        },
      ],
    });
  });

  it("still queues the sync when the cron's shard reconcile fails", async () => {
    expect.hasAssertions();
    const bindings = envWith(keys);
    const sent = captureQueue(bindings);
    vi.spyOn(console, "error");

    // Nothing reaches Discord in tests, so Get Gateway Bot fails and the reconcile with it
    await expect(
      worker.scheduled(createScheduledController(), bindings, createExecutionContext()),
    ).rejects.toBeInstanceOf(Error);

    expect(sent).toMatchObject([{ op: "sync-commands", worker: "bona-fide-bot" }]);
  });

  it("reports the failed reconcile, not the failed send, when both fail", async () => {
    expect.hasAssertions();
    const bindings = envWith(keys);
    vi.spyOn(bindings.DISCORD_QUEUE, "send").mockRejectedValue(new Error("Queue is down"));
    const errors = vi.spyOn(console, "error");

    const result = worker.scheduled(createScheduledController(), bindings, createExecutionContext());

    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.not.toThrow("Queue is down");
    expect(errors).toHaveBeenCalledWith(["Couldn't queue the command sync", new Error("Queue is down")]);
  });
});
