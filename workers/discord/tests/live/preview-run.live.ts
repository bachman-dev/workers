import {
  type APIMessageTopLevelComponent,
  ComponentType,
  type DiscordMessageQueueBody,
} from "@bachman-dev/workers-shared/discord";
import { log } from "@bachman-dev/workers-shared/util";
import { describe, expect, it, vi } from "vitest";

import { type BatchRun, findRef, runBatch } from "../batch.ts";
import liveDiscord from "./discord.ts";

/** Long enough to see each version of the card in Discord before the next one lands. */
const PAUSE_MS = 3000;

vi.setConfig({ testTimeout: 60_000 });

/**
 * Builds a container card holding one line of text.
 *
 * @param {string} content - The text to show.
 * @returns {APIMessageTopLevelComponent} The card.
 */
function card(content: string): APIMessageTopLevelComponent {
  return { type: ComponentType.Container, components: [{ type: ComponentType.TextDisplay, content }] };
}

/**
 * Sends one batch to the consumer, then waits so the result can be seen in Discord.
 *
 * @param {DiscordMessageQueueBody} body - The queued body.
 * @returns {Promise<BatchRun>} What happened to the batch.
 */
async function sendAndPause(body: DiscordMessageQueueBody): Promise<BatchRun> {
  const run = await runBatch([body]);
  await scheduler.wait(PAUSE_MS);
  return run;
}

describe("message refs against Discord", () => {
  it("posts at version 1, edits to version 3, and skips a stale edit at version 2", async () => {
    expect.hasAssertions();
    const { applicationId, channelId, ref } = liveDiscord();

    const post = await sendAndPause({
      format: "message",
      applicationId,
      channelId,
      ref,
      version: 1,
      component: card(`${ref}: version 1`),
    });
    const newer = await sendAndPause({ op: "edit", ref, version: 3, component: card(`${ref}: version 3`) });
    const stale = await sendAndPause({
      op: "edit",
      ref,
      version: 2,
      component: card(`${ref}: version 2 (should never show)`),
    });
    const row = await findRef(ref);
    log("info", "message_refs row:", row);

    expect(post.result.explicitAcks).toStrictEqual(post.ids);
    expect(newer.result.explicitAcks).toStrictEqual(newer.ids);
    expect(stale.result.explicitAcks).toStrictEqual(stale.ids);
    expect(row).toMatchObject({ format: "message", applicationId, channelId, version: 3, deletedAt: null });
  });
});
