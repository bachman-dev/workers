import type { AddSenderRequest } from "@bachman-dev/workers-shared/screener";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { ScreenerService } from "../src/index.ts";
import { screenerStub, testEnv } from "./env.ts";
import makeSender from "./fixtures.ts";

vi.setConfig({ testTimeout: 10_000 });

/**
 * Makes the entrypoint another worker would call over its service binding.
 *
 * @returns {ScreenerService} The entrypoint.
 */
function service(): ScreenerService {
  return new ScreenerService(createExecutionContext(), testEnv);
}

/**
 * Builds a rule to add, as bona-fide-bot would send it.
 *
 * @param {Partial<AddSenderRequest>} overrides - Fields to set.
 * @returns {AddSenderRequest} The rule.
 */
function newRule(overrides: Partial<AddSenderRequest> = {}): AddSenderRequest {
  return { kind: "domain", pattern: "example.com", list: "allow", addedVia: "discord", ...overrides };
}

/**
 * Calls an entrypoint method with arguments its types wouldn't allow, as a caller outside TypeScript could.
 *
 * @param {"addSender" | "removeSender" | "listSenders"} name - The method.
 * @param {unknown[]} args - The arguments.
 * @returns {Promise<unknown>} What the method returned.
 */
async function callUntyped(name: "addSender" | "removeSender" | "listSenders", ...args: unknown[]): Promise<unknown> {
  const entrypoint = service();
  const result: unknown = await Reflect.apply(entrypoint[name], entrypoint, args);
  return result;
}

describe("ScreenerService.addSender()", () => {
  it("adds a rule the next match() sees", async () => {
    expect.hasAssertions();

    const result = await service().addSender(newRule({ pattern: " Example.COM. ", note: " Newsletter " }));

    expect(result).toMatchObject({
      ok: true,
      rule: { kind: "domain", pattern: "example.com", list: "allow", note: "Newsletter", addedVia: "discord" },
    });
    await expect(screenerStub().match(makeSender("jane@example.com"))).resolves.toMatchObject({
      verdict: "known",
      rule: { kind: "domain", pattern: "example.com", list: "allow" },
    });
  });

  it("marks seeded rules as seeded", async () => {
    expect.hasAssertions();

    const result = await service().addSender(
      newRule({ kind: "address", pattern: "Jane+news@Example.com", addedVia: "seed" }),
    );

    expect(result).toMatchObject({
      ok: true,
      rule: { kind: "address", pattern: "jane@example.com", addedVia: "seed" },
    });
  });

  it("replaces a rule with the same kind and pattern on the other list", async () => {
    expect.hasAssertions();
    await service().addSender(newRule({ list: "allow" }));

    await service().addSender(newRule({ list: "deny" }));

    await expect(screenerStub().listSenders()).resolves.toMatchObject([
      { kind: "domain", pattern: "example.com", list: "deny" },
    ]);
    await expect(screenerStub().match(makeSender("jane@example.com"))).resolves.toMatchObject({ verdict: "reject" });
  });

  it("refuses an invalid pattern", async () => {
    expect.hasAssertions();

    const result = await service().addSender(newRule({ kind: "address", pattern: "not an address" }));

    expect(result).toStrictEqual({ ok: false, code: "invalid_pattern", reason: "That isn't a valid email address." });
    await expect(screenerStub().listSenders()).resolves.toStrictEqual([]);
  });

  it("refuses a domain rule for a bare public suffix", async () => {
    expect.hasAssertions();

    await expect(service().addSender(newRule({ pattern: "co.uk" }))).resolves.toMatchObject({
      ok: false,
      code: "invalid_pattern",
    });
  });

  it("refuses an org rule for free mail, which would cover strangers", async () => {
    expect.hasAssertions();

    const result = await service().addSender(newRule({ kind: "org", pattern: "Gmail.com" }));

    expect(result).toMatchObject({ ok: false, code: "free_mail", rule: { kind: "org", pattern: "gmail.com" } });
    await expect(screenerStub().listSenders()).resolves.toStrictEqual([]);
  });

  it("refuses a domain rule under a free-mail parent domain", async () => {
    expect.hasAssertions();

    await expect(service().addSender(newRule({ pattern: "mail.yahoo.co.uk" }))).resolves.toMatchObject({
      ok: false,
      code: "free_mail",
    });
  });

  it("still allows a free-mail address", async () => {
    expect.hasAssertions();

    await expect(
      service().addSender(newRule({ kind: "address", pattern: "someone@gmail.com" })),
    ).resolves.toMatchObject({
      ok: true,
      rule: { pattern: "someone@gmail.com" },
    });
  });

  it("refuses rules marked as added from the CLI", async () => {
    expect.hasAssertions();

    await expect(callUntyped("addSender", { ...newRule(), addedVia: "cli" })).rejects.toThrow(TypeError);
    await expect(screenerStub().listSenders()).resolves.toStrictEqual([]);
  });

  it("refuses unknown kinds and lists, non-string patterns, and long notes", async () => {
    expect.hasAssertions();
    const bad: unknown[] = [
      null,
      { ...newRule(), kind: "host" },
      { ...newRule(), list: "maybe" },
      { ...newRule(), pattern: 42 },
      { ...newRule(), note: 42 },
      newRule({ note: "x".repeat(201) }),
    ];

    for (const rule of bad) {
      // oxlint-disable-next-line no-await-in-loop -- Must be in order
      await expect(callUntyped("addSender", rule)).rejects.toThrow(TypeError);
    }
    await expect(service().addSender(newRule({ note: "x".repeat(200) }))).resolves.toMatchObject({ ok: true });
  });
});

describe("ScreenerService.removeSender()", () => {
  it("removes a rule from whichever list it's on", async () => {
    expect.hasAssertions();
    await service().addSender(newRule({ list: "deny" }));

    const result = await service().removeSender("domain", "EXAMPLE.com");

    expect(result).toStrictEqual({ ok: true, rule: { kind: "domain", pattern: "example.com" } });
    await expect(screenerStub().listSenders()).resolves.toStrictEqual([]);
  });

  it("reports when there's no rule to remove", async () => {
    expect.hasAssertions();
    await service().addSender(newRule({ kind: "org" }));

    const result = await service().removeSender("domain", "example.com");

    expect(result).toMatchObject({ ok: false, code: "not_found", rule: { kind: "domain", pattern: "example.com" } });
    await expect(screenerStub().listSenders()).resolves.toHaveLength(1);
  });

  it("refuses an invalid pattern and an unknown kind", async () => {
    expect.hasAssertions();

    await expect(service().removeSender("address", "nobody")).resolves.toMatchObject({
      ok: false,
      code: "invalid_pattern",
    });
    await expect(callUntyped("removeSender", "host", "example.com")).rejects.toThrow(TypeError);
    await expect(callUntyped("removeSender", "domain", 42)).rejects.toThrow(TypeError);
  });
});

describe("ScreenerService.listSenders()", () => {
  it("lists every rule, or one list's", async () => {
    expect.hasAssertions();
    await service().addSender(newRule({ kind: "address", pattern: "jane@example.com", list: "allow" }));
    await service().addSender(newRule({ kind: "domain", pattern: "example.co.uk", list: "deny" }));
    await service().addSender(newRule({ kind: "org", pattern: "example.com", list: "allow" }));

    const all = await service().listSenders();
    const allowed = await service().listSenders("allow");
    const denied = await service().listSenders("deny");

    expect(all.map((rule) => rule.pattern)).toStrictEqual(["jane@example.com", "example.co.uk", "example.com"]);
    expect(allowed.map((rule) => rule.pattern)).toStrictEqual(["jane@example.com", "example.com"]);
    expect(denied.map((rule) => rule.pattern)).toStrictEqual(["example.co.uk"]);
  });

  it("refuses an unknown list", async () => {
    expect.hasAssertions();

    await expect(callUntyped("listSenders", "maybe")).rejects.toThrow(TypeError);
  });
});
