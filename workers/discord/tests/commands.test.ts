import type { DiscordSyncCommandsQueueBody } from "@bachman-dev/workers-shared/discord";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { runBatch } from "./batch.ts";
import { requests } from "./discord.ts";

vi.setConfig({ testTimeout: 10_000 });

describe("sync-commands", () => {
  it("is dead-lettered as an unknown op until the consumer handles it", async () => {
    expect.hasAssertions();
    const deadLetters = vi.spyOn(env.DEAD_LETTER_QUEUE, "sendBatch");
    const body: DiscordSyncCommandsQueueBody = {
      op: "sync-commands",
      applicationId: "100",
      worker: "example-bot",
      commands: [],
    };

    const { ids, result } = await runBatch([body]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests).toStrictEqual([]);
    expect(deadLetters.mock.calls[0]?.[0]).toMatchObject([
      { body: { error: "DISCORD_QUEUE_OP_UNKNOWN" }, contentType: "json" },
    ]);
  });
});
