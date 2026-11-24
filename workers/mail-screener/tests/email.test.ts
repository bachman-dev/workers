import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index.ts";
import Screener from "../src/screener.ts";
import type { Env } from "../src/types/cloudflare.ts";
import { screenerStub, testEnv } from "./env.ts";
import FakeEmailMessage from "./message.ts";

vi.setConfig({ testTimeout: 10_000 });

const DESTINATION = "inbox@example.com";
const PASS = "mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com; spf=pass";
const FAIL = "mx.cloudflare.net; dkim=fail header.d=example.com; dmarc=fail header.from=example.com; spf=fail";

/**
 * Runs the worker's email handler on a message.
 *
 * @param {FakeEmailMessage} message - The message.
 * @param {Env} env - The bindings to run with; the test bindings by default.
 * @returns {Promise<void>} Resolves once the handler is done.
 */
async function receive(message: FakeEmailMessage, env: Env = testEnv): Promise<void> {
  await worker.email(message, env);
}

/**
 * Reads the X-Screener header of each forward.
 *
 * @param {FakeEmailMessage} message - The message.
 * @returns {{ rcptTo: string; tag: string | null }[]} Where each forward went and how it was tagged.
 */
function forwards(message: FakeEmailMessage): { rcptTo: string; tag: string | null }[] {
  return message.forwarded.map(({ rcptTo, headers }) => {
    return { rcptTo, tag: headers.get("x-screener") };
  });
}

/**
 * Adds a sender rule to the Screener.
 *
 * @param {"address" | "domain" | "org"} kind - What it matches.
 * @param {string} pattern - The pattern.
 * @param {"allow" | "deny"} list - Allow or deny.
 * @returns {Promise<void>} Resolves once it's stored.
 */
async function addRule(kind: "address" | "domain" | "org", pattern: string, list: "allow" | "deny"): Promise<void> {
  await screenerStub().addSender({ kind, pattern, list, addedVia: "seed" });
}

describe("email()", () => {
  it("forwards a known sender tagged known", async () => {
    expect.hasAssertions();
    await addRule("org", "example.com", "allow");
    const message = new FakeEmailMessage({
      headers: { from: "Jane <jane@mail.example.com>", "authentication-results": PASS },
    });

    await receive(message);

    expect(forwards(message)).toStrictEqual([{ rcptTo: DESTINATION, tag: "known" }]);
    expect(message.rejections).toStrictEqual([]);
    await expect(screenerStub().listOpen()).resolves.toStrictEqual([]);
  });

  it("forwards an unknown sender tagged unknown and opens a review", async () => {
    expect.hasAssertions();
    const message = new FakeEmailMessage({
      headers: {
        from: '"Doe, Jane" <jane+news@example.com>',
        subject: "=?UTF-8?Q?Caf=C3=A9?=",
        "authentication-results": PASS,
      },
    });

    await receive(message);

    expect(forwards(message)).toStrictEqual([{ rcptTo: DESTINATION, tag: "unknown" }]);
    await expect(screenerStub().listOpen()).resolves.toMatchObject([
      { fromAddr: "jane@example.com", fromName: "Doe, Jane", subject: "Café", count: 1, dmarc: "pass" },
    ]);
  });

  it("forwards a spoofed allowlisted sender tagged unknown", async () => {
    expect.hasAssertions();
    await addRule("address", "jane@example.com", "allow");
    const message = new FakeEmailMessage({
      headers: { from: "jane@example.com", "authentication-results": [FAIL, "mx.cloudflare.net; dmarc=pass"] },
    });

    await receive(message);

    expect(forwards(message)).toStrictEqual([{ rcptTo: DESTINATION, tag: "unknown" }]);
    await expect(screenerStub().listOpen()).resolves.toMatchObject([{ fromAddr: "jane@example.com", dmarc: "fail" }]);
  });

  it("rejects a denied sender without forwarding it", async () => {
    expect.hasAssertions();
    await addRule("domain", "spammy.example.com", "deny");
    const message = new FakeEmailMessage({
      headers: { from: "x@spammy.example.com", "authentication-results": PASS },
    });

    await receive(message);

    expect(message.forwarded).toStrictEqual([]);
    expect(message.rejections).toHaveLength(1);
    await expect(screenerStub().listOpen()).resolves.toStrictEqual([]);
  });

  it("fails open, tagged error, when matching throws", async () => {
    expect.hasAssertions();
    vi.spyOn(Screener.prototype, "match").mockImplementation(() => {
      throw new Error("Storage is down");
    });
    const message = new FakeEmailMessage({ headers: { from: "jane@example.com", "authentication-results": PASS } });

    await receive(message);

    expect(forwards(message)).toStrictEqual([{ rcptTo: DESTINATION, tag: "error" }]);
    expect(message.rejections).toStrictEqual([]);
  });

  it("still forwards an unknown sender when the review can't be opened", async () => {
    expect.hasAssertions();
    vi.spyOn(Screener.prototype, "openReview").mockImplementation(() => {
      throw new Error("Storage is down");
    });
    const message = new FakeEmailMessage({ headers: { from: "jane@example.com", "authentication-results": PASS } });

    await expect(receive(message)).resolves.toBeUndefined();

    expect(forwards(message)).toStrictEqual([{ rcptTo: DESTINATION, tag: "unknown" }]);
  });

  it("forwards a message with no readable From tagged unknown, without a review", async () => {
    expect.hasAssertions();
    const message = new FakeEmailMessage({ headers: { from: "Undisclosed recipients:;" } });

    await receive(message);

    expect(forwards(message)).toStrictEqual([{ rcptTo: DESTINATION, tag: "unknown" }]);
    await expect(screenerStub().listOpen()).resolves.toStrictEqual([]);
  });

  it("rethrows when forward() fails", async () => {
    expect.hasAssertions();
    const error = new Error("Destination address not verified");
    const message = new FakeEmailMessage({ headers: { from: "jane@example.com" }, forwardError: error });

    await expect(receive(message)).rejects.toBe(error);
  });

  it("rejects a message that can't be forwarded", async () => {
    expect.hasAssertions();
    const message = new FakeEmailMessage({
      headers: { from: "jane@example.com", "authentication-results": PASS },
      canBeForwarded: false,
    });

    await receive(message);

    expect(message.forwarded).toStrictEqual([]);
    expect(message.rejections).toHaveLength(1);
    await expect(screenerStub().listOpen()).resolves.toStrictEqual([]);
  });

  it.for(["loop@bachman.dev", "Loop@BACHMAN.dev", "loop@mail.bachman.dev"])(
    "refuses to forward to %s, which would loop back",
    async (destination) => {
      expect.hasAssertions();
      const message = new FakeEmailMessage({ headers: { from: "jane@example.com", "authentication-results": PASS } });

      await expect(receive(message, { ...testEnv, DESTINATION: destination })).rejects.toThrow(/bachman\.dev/v);

      expect(message.forwarded).toStrictEqual([]);
      expect(message.rejections).toStrictEqual([]);
    },
  );

  it("never replies or reads the message body", async () => {
    expect.hasAssertions();
    const message = new FakeEmailMessage({ headers: { from: "jane@example.com", "authentication-results": PASS } });

    await receive(message);

    expect(message.replies).toBe(0);
    expect(message.raw.locked).toBe(false);
  });

  it("checks rules in the Screener named for the domain", async () => {
    expect.hasAssertions();
    const message = new FakeEmailMessage({ headers: { from: "jane@example.com", "authentication-results": PASS } });

    await receive(message);

    await expect(
      runInDurableObject(screenerStub(), (instance) => instance.listOpen().map((review) => review.fromAddr)),
    ).resolves.toStrictEqual(["jane@example.com"]);
  });
});
