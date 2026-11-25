import { InteractionResponseType, MessageFlags } from "@bachman-dev/workers-shared/discord";
import type { StoredRule } from "@bachman-dev/workers-shared/screener";
import { describe, expect, it, vi } from "vitest";

import {
  OWNER_ID,
  STRANGER_ID,
  booleanOption,
  envWith,
  fakeScreener,
  makeSigningKeys,
  responseBody,
  screenCommand,
  sendInteraction,
  storedRule,
  stringOption,
} from "./interactions.ts";

vi.setConfig({ testTimeout: 10_000 });

const keys = await makeSigningKeys();
const MAX_MESSAGE_LENGTH = 2000;
const MANY_RULES = 60;
const LONG_NOTE_LENGTH = 40;
const NOTE_LIMIT = 200;
const OWNER = { in: "guild", userId: OWNER_ID } as const;

/** What a /screen reply carries. */
interface Reply {
  content: string;
  flags: unknown;
  allowedMentions: unknown;
}

/**
 * Reads an ephemeral reply from the worker's response, failing the test if it isn't one.
 *
 * @param {Response} response - The worker's response.
 * @returns {Promise<Reply>} The reply's text, flags and allowed mentions.
 */
async function readReply(response: Response): Promise<Reply> {
  const body = await responseBody(response);
  if (
    typeof body !== "object" ||
    body === null ||
    !("type" in body) ||
    body.type !== InteractionResponseType.ChannelMessageWithSource ||
    !("data" in body) ||
    typeof body.data !== "object" ||
    body.data === null ||
    !("content" in body.data) ||
    typeof body.data.content !== "string"
  ) {
    throw new TypeError("Expected a message reply");
  }
  return {
    content: body.data.content,
    flags: "flags" in body.data ? body.data.flags : undefined,
    allowedMentions: "allowed_mentions" in body.data ? body.data.allowed_mentions : undefined,
  };
}

/**
 * Runs a /screen subcommand as the owner and reads the reply.
 *
 * @param {Parameters<typeof screenCommand>} args - The subcommand, its options, and who ran it.
 * @param {ReturnType<typeof fakeScreener>} fake - The Screener to answer it.
 * @returns {Promise<Reply>} The reply.
 */
async function run(args: Parameters<typeof screenCommand>, fake = fakeScreener()): Promise<Reply> {
  return await readReply(await sendInteraction(screenCommand(...args), envWith(keys, fake.screener), keys));
}

/**
 * Makes rules with long notes, so listing them all wouldn't fit in one message.
 *
 * @param {number} count - How many.
 * @param {StoredRule["list"]} list - Their list.
 * @returns {StoredRule[]} The rules.
 */
function manyRules(count: number, list: StoredRule["list"]): StoredRule[] {
  return Array.from({ length: count }, (_value, index) =>
    storedRule({ kind: "address", pattern: `sender${index}@example.com`, list, note: "n".repeat(LONG_NOTE_LENGTH) }),
  );
}

describe("/screen allow and deny", () => {
  it("allows a domain for that exact host", async () => {
    expect.hasAssertions();
    const fake = fakeScreener();

    const reply = await run(["allow", [stringOption("target", "example.com")], OWNER], fake);

    expect(fake.calls).toStrictEqual([
      {
        method: "addSender",
        args: [{ kind: "domain", pattern: "example.com", list: "allow", note: null, addedVia: "discord" }],
      },
    ]);
    expect(reply).toStrictEqual({
      content: "Allowed `example.com` (domain)",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  });

  it("denies an address, with a note", async () => {
    expect.hasAssertions();
    const fake = fakeScreener();

    const reply = await run(
      ["deny", [stringOption("target", "jane@example.co.uk"), stringOption("note", "Unwanted")], OWNER],
      fake,
    );

    expect(fake.calls).toStrictEqual([
      {
        method: "addSender",
        args: [{ kind: "address", pattern: "jane@example.co.uk", list: "deny", note: "Unwanted", addedVia: "discord" }],
      },
    ]);
    expect(reply.content).toBe("Denied `jane@example.co.uk` (address)");
  });

  it("splits off org: and shows the rule as the Screener normalized it", async () => {
    expect.hasAssertions();
    const fake = fakeScreener({
      addSender: async () =>
        await Promise.resolve({ ok: true, rule: storedRule({ kind: "org", pattern: "example.co.uk" }) }),
    });

    const reply = await run(["allow", [stringOption("target", "ORG:Shop.Example.co.uk ")], OWNER], fake);

    expect(fake.calls[0]?.args).toStrictEqual([
      { kind: "org", pattern: "Shop.Example.co.uk", list: "allow", note: null, addedVia: "discord" },
    ]);
    expect(reply.content).toBe("Allowed `example.co.uk` (org)");
  });

  it("marks the rule as seeded with seed:true", async () => {
    expect.hasAssertions();
    const fake = fakeScreener();

    await run(["allow", [stringOption("target", "example.com"), booleanOption("seed", true)], OWNER], fake);
    await run(["allow", [stringOption("target", "example.com"), booleanOption("seed", false)], OWNER], fake);

    expect(fake.calls.map((call) => call.args[0])).toMatchObject([{ addedVia: "seed" }, { addedVia: "discord" }]);
  });

  it("passes the Screener's refusals through", async () => {
    expect.hasAssertions();
    const freeMail = fakeScreener({
      addSender: async () =>
        await Promise.resolve({
          ok: false,
          code: "free_mail",
          reason: "That's a free-mail domain.",
          rule: { kind: "org", pattern: "example-mail.com" },
        }),
    });
    const invalid = fakeScreener({
      addSender: async () =>
        await Promise.resolve({ ok: false, code: "invalid_pattern", reason: "That isn't a valid domain." }),
    });

    const refused = await run(["allow", [stringOption("target", "org:Example-Mail.com")], OWNER], freeMail);
    const malformed = await run(["deny", [stringOption("target", "not a `domain`")], OWNER], invalid);

    expect(refused.content).toBe("Couldn't allow `example-mail.com` (org): That's a free-mail domain.");
    expect(malformed.content).toBe("Couldn't deny `not a ˋdomainˋ`: That isn't a valid domain.");
  });

  it("refuses a note longer than the Screener keeps without calling it", async () => {
    expect.hasAssertions();
    const fake = fakeScreener();

    const reply = await run(
      ["allow", [stringOption("target", "example.com"), stringOption("note", "n".repeat(NOTE_LIMIT + 1))], OWNER],
      fake,
    );

    expect(fake.calls).toStrictEqual([]);
    expect(reply.content).toBe("Notes can be at most 200 characters.");
  });
});

describe("/screen remove", () => {
  it("removes a rule", async () => {
    expect.hasAssertions();
    const fake = fakeScreener();

    const reply = await run(["remove", [stringOption("target", "org:example.com")], OWNER], fake);

    expect(fake.calls).toStrictEqual([{ method: "removeSender", args: ["org", "example.com"] }]);
    expect(reply.content).toBe("Removed `example.com` (org)");
  });

  it("says when there's no rule to remove", async () => {
    expect.hasAssertions();
    const fake = fakeScreener({
      removeSender: async () =>
        await Promise.resolve({
          ok: false,
          code: "not_found",
          reason: "There's no rule for that.",
          rule: { kind: "address", pattern: "jane@example.com" },
        }),
    });

    const reply = await run(["remove", [stringOption("target", "Jane@Example.com")], OWNER], fake);

    expect(fake.calls).toStrictEqual([{ method: "removeSender", args: ["address", "Jane@Example.com"] }]);
    expect(reply.content).toBe("No rule for `jane@example.com` (address)");
  });
});

describe("/screen list", () => {
  it("groups the rules into allow and deny, with notes as code", async () => {
    expect.hasAssertions();
    const fake = fakeScreener({
      listSenders: async () =>
        await Promise.resolve([
          storedRule({ kind: "address", pattern: "jane@example.com", list: "deny", note: "Sent `spam`" }),
          storedRule({ kind: "domain", pattern: "example.com", list: "allow" }),
          storedRule({ kind: "org", pattern: "example.co.uk", list: "allow", note: "Shop" }),
        ]),
    });

    const reply = await run(["list", [], OWNER], fake);

    expect(fake.calls).toStrictEqual([{ method: "listSenders", args: [] }]);
    expect(reply.content).toBe(
      [
        "**Allow** (2)",
        "- domain `example.com`",
        "- org `example.co.uk` — `Shop`",
        "**Deny** (1)",
        "- address `jane@example.com` — `Sent ˋspamˋ`",
      ].join("\n"),
    );
    expect(reply.flags).toBe(MessageFlags.Ephemeral);
  });

  it("filters to one list", async () => {
    expect.hasAssertions();
    const fake = fakeScreener({
      listSenders: async () => await Promise.resolve([storedRule({ list: "deny", pattern: "example.co.uk" })]),
    });

    const reply = await run(["list", [stringOption("list", "deny")], OWNER], fake);

    expect(fake.calls).toStrictEqual([{ method: "listSenders", args: ["deny"] }]);
    expect(reply.content).toBe("**Deny** (1)\n- domain `example.co.uk`");
  });

  it("says when there are no rules", async () => {
    expect.hasAssertions();

    const all = await run(["list", [], OWNER]);
    const allowed = await run(["list", [stringOption("list", "allow")], OWNER]);

    expect(all.content).toBe("No sender rules yet.");
    expect(allowed.content).toBe("No allow rules.");
  });

  it("stays inside Discord's message limit and counts the rules left out", async () => {
    expect.hasAssertions();
    const rules = [...manyRules(MANY_RULES, "allow"), ...manyRules(MANY_RULES, "deny")];
    const fake = fakeScreener({ listSenders: async () => await Promise.resolve(rules) });

    const reply = await run(["list", [], OWNER], fake);

    const shown = reply.content.split("\n").filter((line) => line.startsWith("- ")).length;
    expect(reply.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(shown).toBeGreaterThan(0);
    expect(reply.content.endsWith(`…and ${rules.length - shown} more. Use \`list:\` to show one list.`)).toBe(true);
  });

  it("leaves out the filter hint when the list is already filtered", async () => {
    expect.hasAssertions();
    const rules = manyRules(MANY_RULES, "deny");
    const fake = fakeScreener({ listSenders: async () => await Promise.resolve(rules) });

    const reply = await run(["list", [stringOption("list", "deny")], OWNER], fake);

    const shown = reply.content.split("\n").filter((line) => line.startsWith("- ")).length;
    expect(reply.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(reply.content.endsWith(`\n…and ${rules.length - shown} more.`)).toBe(true);
  });
});

describe("/screen", () => {
  it.for([
    { where: "in a server", presser: { in: "guild", userId: STRANGER_ID } },
    { where: "in a DM", presser: { in: "dm", userId: STRANGER_ID } },
  ] as const)("refuses anyone but the owner $where without calling the Screener", async ({ presser }) => {
    expect.hasAssertions();
    const fake = fakeScreener();

    const reply = await run(["allow", [stringOption("target", "example.com")], presser], fake);

    expect(fake.calls).toStrictEqual([]);
    expect(reply).toStrictEqual({
      content: "This isn't yours to change.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  });

  it("works for the owner in a DM", async () => {
    expect.hasAssertions();
    const fake = fakeScreener();

    await run(["list", [], { in: "dm", userId: OWNER_ID }], fake);

    expect(fake.calls).toHaveLength(1);
  });

  it("answers ephemerally when the Screener can't be reached", async () => {
    expect.hasAssertions();
    const errors = vi.spyOn(console, "error");
    const fake = fakeScreener({ listSenders: async () => await Promise.reject(new Error("No such method")) });

    const reply = await run(["list", [], OWNER], fake);

    expect(reply.content).toBe("Couldn't reach the screener. Try again in a moment.");
    expect(errors).toHaveBeenCalledOnce();
  });

  it("says the screener isn't available where SCREENER isn't bound", async () => {
    expect.hasAssertions();

    const response = await sendInteraction(screenCommand("list", [], OWNER), envWith(keys), keys);

    await expect(readReply(response)).resolves.toMatchObject({ content: "The screener isn't available here." });
  });

  it("answers commands the bot doesn't have with 501", async () => {
    expect.hasAssertions();
    const command = { ...screenCommand("list", [], OWNER), data: { id: "1", name: "other", type: 1 } };

    const response = await sendInteraction(command, envWith(keys, fakeScreener().screener), keys);

    expect(response.status).toBe(501);
  });
});
