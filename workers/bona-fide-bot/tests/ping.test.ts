import { InteractionResponseType } from "@bachman-dev/workers-shared/discord";
import { describe, expect, it, vi } from "vitest";

import { envWith, makeSigningKeys, ping, responseBody, sendInteraction } from "./interactions.ts";

vi.setConfig({ testTimeout: 10_000 });

const keys = await makeSigningKeys();

describe("interactions endpoint", () => {
  it("answers a signed Ping with a Pong", async () => {
    expect.hasAssertions();

    const response = await sendInteraction(ping(), envWith(keys), keys);

    expect(response.status).toBe(200);
    await expect(responseBody(response)).resolves.toStrictEqual({ type: InteractionResponseType.Pong });
  });

  it("refuses a request with a bad signature", async () => {
    expect.hasAssertions();

    const response = await sendInteraction(ping(), envWith(keys), keys, { signature: "00".repeat(64) });

    expect(response.status).toBe(401);
  });

  it("refuses a request signed with another key", async () => {
    expect.hasAssertions();
    const otherKeys = await makeSigningKeys();

    const response = await sendInteraction(ping(), envWith(keys), otherKeys);

    expect(response.status).toBe(401);
  });

  it("refuses a request with an empty or malformed signature", async () => {
    expect.hasAssertions();

    const empty = await sendInteraction(ping(), envWith(keys), keys, { signature: "" });
    const short = await sendInteraction(ping(), envWith(keys), keys, { signature: "abcd" });

    expect(empty.status).toBe(401);
    expect(short.status).toBe(401);
  });

  it("refuses a request with no signature headers", async () => {
    expect.hasAssertions();

    const response = await sendInteraction(ping(), envWith(keys), keys, { signature: null });

    expect(response.status).toBe(401);
  });
});
