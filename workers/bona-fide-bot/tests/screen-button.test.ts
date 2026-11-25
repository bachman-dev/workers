import { InteractionResponseType, MessageFlags } from "@bachman-dev/workers-shared/discord";
import { SCREENER_REVIEW_ACTIONS } from "@bachman-dev/workers-shared/screener";
import { describe, expect, it, vi } from "vitest";

import {
  OWNER_ID,
  STRANGER_ID,
  buttonPress,
  closedCard,
  envWith,
  fakeScreener,
  makeSigningKeys,
  responseBody,
  sendInteraction,
} from "./interactions.ts";

vi.setConfig({ testTimeout: 10_000 });

const keys = await makeSigningKeys();
const REVIEW_ID = "01JDV3Q8ZK5N7R2T4W6X8Y0A1B";

/**
 * Builds the ephemeral reply the bot gives when nothing changes.
 *
 * @param {string} content - The reply's text.
 * @returns {unknown} The interaction response.
 */
function ephemeralReply(content: string): unknown {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content, flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } },
  };
}

describe("review buttons", () => {
  it.for(SCREENER_REVIEW_ACTIONS)("decides %s and updates the card when the owner presses it", async (action) => {
    expect.hasAssertions();
    const card = closedCard(`Decided ${action}`);
    const { screener, calls } = fakeScreener({ decide: async () => await Promise.resolve(card) });

    const response = await sendInteraction(
      buttonPress(`screen:${action}:${REVIEW_ID}`, { in: "guild", userId: OWNER_ID }),
      envWith(keys, screener),
      keys,
    );

    expect(calls).toStrictEqual([{ method: "decide", args: [REVIEW_ID, action] }]);
    expect(response.status).toBe(200);
    await expect(responseBody(response)).resolves.toStrictEqual({
      type: InteractionResponseType.UpdateMessage,
      data: { components: [card], flags: MessageFlags.IsComponentsV2, allowed_mentions: { parse: [] } },
    });
  });

  it("lets the owner decide from a DM", async () => {
    expect.hasAssertions();
    const card = closedCard("Decided");
    const { screener, calls } = fakeScreener({ decide: async () => await Promise.resolve(card) });

    const response = await sendInteraction(
      buttonPress(`screen:dismiss:${REVIEW_ID}`, { in: "dm", userId: OWNER_ID }),
      envWith(keys, screener),
      keys,
    );

    expect(calls).toStrictEqual([{ method: "decide", args: [REVIEW_ID, "dismiss"] }]);
    await expect(responseBody(response)).resolves.toMatchObject({ type: InteractionResponseType.UpdateMessage });
  });

  it.for([
    { where: "in a server", presser: { in: "guild", userId: STRANGER_ID } },
    { where: "in a DM", presser: { in: "dm", userId: STRANGER_ID } },
  ] as const)("refuses anyone but the owner $where", async ({ presser }) => {
    expect.hasAssertions();
    const { screener, calls } = fakeScreener();

    const response = await sendInteraction(
      buttonPress(`screen:allow_sender:${REVIEW_ID}`, presser),
      envWith(keys, screener),
      keys,
    );

    expect(calls).toStrictEqual([]);
    await expect(responseBody(response)).resolves.toStrictEqual(ephemeralReply("This isn't yours to decide."));
  });

  it.for([
    "screen:allow_sender",
    `screen:allow_sender:${REVIEW_ID}:extra`,
    "screen:allow_sender:01JDV3Q8ZK",
    `screen:allow_sender:${REVIEW_ID.toLowerCase()}`,
    // Crockford's base32 has no I, L, O or U
    "screen:allow_sender:01JDV3Q8ZK5N7R2T4W6X8Y0AIL",
    "screen:approve_sender:01JDV3Q8ZK5N7R2T4W6X8Y0A1B",
    "screen::01JDV3Q8ZK5N7R2T4W6X8Y0A1B",
  ])("answers %s with Unknown button and calls nothing", async (customId) => {
    expect.hasAssertions();
    const { screener, calls } = fakeScreener();

    const response = await sendInteraction(
      buttonPress(customId, { in: "guild", userId: OWNER_ID }),
      envWith(keys, screener),
      keys,
    );

    expect(calls).toStrictEqual([]);
    await expect(responseBody(response)).resolves.toStrictEqual(ephemeralReply("Unknown button."));
  });

  it("says so when the review no longer exists", async () => {
    expect.hasAssertions();
    const { screener, calls } = fakeScreener({ decide: async () => await Promise.resolve(null) });

    const response = await sendInteraction(
      buttonPress(`screen:block_org:${REVIEW_ID}`, { in: "guild", userId: OWNER_ID }),
      envWith(keys, screener),
      keys,
    );

    expect(calls).toHaveLength(1);
    await expect(responseBody(response)).resolves.toStrictEqual(ephemeralReply("This review no longer exists."));
  });

  it("answers ephemerally instead of failing when decide() throws", async () => {
    expect.hasAssertions();
    const errors = vi.spyOn(console, "error");
    const { screener } = fakeScreener({ decide: async () => await Promise.reject(new Error("Screener is down")) });

    const response = await sendInteraction(
      buttonPress(`screen:allow_domain:${REVIEW_ID}`, { in: "guild", userId: OWNER_ID }),
      envWith(keys, screener),
      keys,
    );

    expect(response.status).toBe(200);
    await expect(responseBody(response)).resolves.toStrictEqual(
      ephemeralReply("Couldn't record that. Try again in a moment."),
    );
    expect(errors).toHaveBeenCalledOnce();
  });

  it("says the screener isn't available where SCREENER isn't bound", async () => {
    expect.hasAssertions();

    const response = await sendInteraction(
      buttonPress(`screen:allow_sender:${REVIEW_ID}`, { in: "guild", userId: OWNER_ID }),
      envWith(keys),
      keys,
    );

    await expect(responseBody(response)).resolves.toStrictEqual(ephemeralReply("The screener isn't available here."));
  });

  it("still answers other buttons with 501", async () => {
    expect.hasAssertions();
    const { screener, calls } = fakeScreener();

    const response = await sendInteraction(
      buttonPress("other:thing", { in: "guild", userId: OWNER_ID }),
      envWith(keys, screener),
      keys,
    );

    expect(response.status).toBe(501);
    expect(calls).toStrictEqual([]);
  });
});
