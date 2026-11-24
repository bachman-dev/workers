import { describe, expect, it, vi } from "vitest";

import {
  type Dmarc,
  type RuleKind,
  type RuleList,
  type Sender,
  type SenderRule,
  type Verdict,
  decide,
  isFreeMail,
  normalizePattern,
  parseFrom,
  parseSender,
  readDmarc,
} from "../src/durable/screener/decide.ts";

vi.setConfig({ testTimeout: 10_000 });

const CLOUDFLARE_PASS =
  "mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com; spf=pass";
const CLOUDFLARE_FAIL =
  "mx.cloudflare.net; dkim=fail header.d=example.com; dmarc=fail header.from=example.com; spf=fail";

/**
 * Builds a rule.
 *
 * @param {RuleKind} kind - What it matches.
 * @param {string} pattern - The normalized pattern.
 * @param {RuleList} list - Allow or deny.
 * @returns {SenderRule} The rule.
 */
function rule(kind: RuleKind, pattern: string, list: RuleList): SenderRule {
  return { kind, pattern, list };
}

/**
 * Builds message headers with a header From and, optionally, Authentication-Results values in the order they'd appear.
 *
 * @param {string} from - The header From.
 * @param {string[]} authenticationResults - Authentication-Results values, Cloudflare's first.
 * @returns {Headers} The headers.
 */
function headers(from: string, ...authenticationResults: string[]): Headers {
  const result = new Headers({ from });
  for (const value of authenticationResults) {
    result.append("authentication-results", value);
  }
  return result;
}

/**
 * Parses a sender, failing the test if it can't be.
 *
 * @param {Headers} messageHeaders - The message's headers.
 * @returns {Sender} The sender.
 */
function sender(messageHeaders: Headers): Sender {
  const parsed = parseSender(messageHeaders);
  if (parsed === null) {
    throw new Error("Expected a sender");
  }
  return parsed;
}

describe("parseFrom", () => {
  it.for([
    { from: "jane@example.com", address: "jane@example.com", name: null },
    { from: "<jane@example.com>", address: "jane@example.com", name: null },
    { from: "Jane Doe <jane@example.com>", address: "jane@example.com", name: "Jane Doe" },
    { from: '"Doe, Jane" <jane@example.com>', address: "jane@example.com", name: "Doe, Jane" },
    {
      from: '"Jane <the boss> Doe" <jane@example.com>',
      address: "jane@example.com",
      name: "Jane <the boss> Doe",
    },
    { from: String.raw`"Jane \"JD\" Doe" <jane@example.com>`, address: "jane@example.com", name: 'Jane "JD" Doe' },
    { from: '"a@evil.example.com" <jane@example.com>', address: "jane@example.com", name: "a@evil.example.com" },
    { from: "jane@example.com (Jane Doe)", address: "jane@example.com", name: "Jane Doe" },
    { from: "Jane (work) <jane@example.com>", address: "jane@example.com", name: "Jane" },
    { from: "=?UTF-8?B?SsOpcsO0bWU=?= <j@example.com>", address: "j@example.com", name: "Jérôme" },
    { from: "=?ISO-8859-1?Q?Andr=E9_M?= <andre@example.com>", address: "andre@example.com", name: "André M" },
    { from: "Jane Doe <Jane.Doe+Newsletters@Example.COM>", address: "jane.doe@example.com", name: "Jane Doe" },
    { from: "Jane <jane@example.com>, Bob <bob@example.org>", address: "jane@example.com", name: "Jane" },
  ])("reads $from", ({ from, address, name }) => {
    expect.hasAssertions();

    expect(parseFrom(from)).toStrictEqual({ address, name });
  });

  it.for(["", "Jane Doe", "<>", "jane@", "@example.com", "jane@localhost", "Undisclosed recipients:;"])(
    "rejects %j",
    (from) => {
      expect.hasAssertions();

      expect(parseFrom(from)).toBeNull();
    },
  );
});

describe("parseSender", () => {
  it("finds the exact and parent domains", () => {
    expect.hasAssertions();

    expect(sender(headers("Shop <orders@shop.example.co.uk>", CLOUDFLARE_PASS))).toStrictEqual({
      address: "orders@shop.example.co.uk",
      name: "Shop",
      domain: "shop.example.co.uk",
      org: "example.co.uk",
      dmarc: "pass",
    });
  });

  it("reads the header From, not some other address", () => {
    expect.hasAssertions();
    const messageHeaders = headers("jane@example.com");
    messageHeaders.set("sender", "bounces@example.org");
    messageHeaders.set("return-path", "<bounces@example.org>");

    expect(sender(messageHeaders).address).toBe("jane@example.com");
  });

  it("returns null without a header From", () => {
    expect.hasAssertions();

    expect(parseSender(new Headers())).toBeNull();
  });
});

describe("readDmarc", () => {
  it.for<{ name: string; value: string | null; dmarc: Dmarc }>([
    { name: "missing", value: null, dmarc: "none" },
    { name: "Cloudflare's pass", value: CLOUDFLARE_PASS, dmarc: "pass" },
    { name: "Cloudflare's fail", value: CLOUDFLARE_FAIL, dmarc: "fail" },
    { name: "Cloudflare's none", value: "mx.cloudflare.net; dkim=none; dmarc=none; spf=none", dmarc: "none" },
    { name: "Cloudflare without DMARC", value: "mx.cloudflare.net; spf=pass", dmarc: "none" },
    { name: "a temperror", value: "mx.cloudflare.net; dmarc=temperror", dmarc: "none" },
    { name: "mixed case", value: "MX.Cloudflare.NET; DMARC=Pass", dmarc: "pass" },
    { name: "a version after the authserv-id", value: "mx.cloudflare.net 1; dmarc=pass", dmarc: "pass" },
    { name: "another server's pass", value: "mx.example.com; dmarc=pass", dmarc: "none" },
    { name: "a lookalike authserv-id", value: "mx.cloudflare.net.example.com; dmarc=pass", dmarc: "none" },
    {
      name: "commas inside Cloudflare's comments",
      value: "mx.cloudflare.net; spf=pass (mx.cloudflare.net: domain of a, b designates c, d); dmarc=pass",
      dmarc: "pass",
    },
    {
      name: "a dmarc=pass in a comment",
      value: "mx.cloudflare.net; spf=fail (dmarc=pass); dmarc=fail",
      dmarc: "fail",
    },
  ])("reads $name as $dmarc", ({ value, dmarc }) => {
    expect.hasAssertions();

    expect(readDmarc(value)).toBe(dmarc);
  });

  it("only reads Cloudflare's leading header, not one the sender added after it", () => {
    expect.hasAssertions();
    const messageHeaders = headers("jane@example.com", CLOUDFLARE_FAIL, "mx.cloudflare.net; dmarc=pass");

    // Headers.get() joins the repeats with ", "
    expect(messageHeaders.get("authentication-results")).toBe(`${CLOUDFLARE_FAIL}, mx.cloudflare.net; dmarc=pass`);
    expect(sender(messageHeaders).dmarc).toBe("fail");
  });

  it("ignores a sender's header when Cloudflare's isn't first", () => {
    expect.hasAssertions();

    expect(readDmarc(`mx.example.com; dmarc=pass, ${CLOUDFLARE_PASS}`)).toBe("none");
  });
});

describe("decide", () => {
  it.for<{
    name: string;
    from: string;
    authenticationResults?: string[];
    rules: SenderRule[];
    verdict: Verdict;
    decidedBy?: string;
  }>([
    { name: "no rules", from: "jane@example.com", rules: [], verdict: "unknown" },
    {
      name: "an allowed address",
      from: "jane@example.com",
      rules: [rule("address", "jane@example.com", "allow")],
      verdict: "known",
      decidedBy: "address",
    },
    {
      name: "an allowed domain",
      from: "jane@example.com",
      rules: [rule("domain", "example.com", "allow")],
      verdict: "known",
      decidedBy: "domain",
    },
    {
      name: "an allowed org",
      from: "jane@example.com",
      rules: [rule("org", "example.com", "allow")],
      verdict: "known",
      decidedBy: "org",
    },
    {
      name: "a denied address under an allowed domain",
      from: "spam@example.com",
      rules: [rule("domain", "example.com", "allow"), rule("address", "spam@example.com", "deny")],
      verdict: "reject",
      decidedBy: "address",
    },
    {
      name: "an allowed address under a denied domain",
      from: "jane@example.com",
      rules: [rule("domain", "example.com", "deny"), rule("address", "jane@example.com", "allow")],
      verdict: "known",
      decidedBy: "address",
    },
    {
      name: "an allowed address under a denied parent domain",
      from: "jane@mail.example.com",
      rules: [rule("org", "example.com", "deny"), rule("address", "jane@mail.example.com", "allow")],
      verdict: "known",
      decidedBy: "address",
    },
    {
      name: "an allowed domain under a denied parent domain",
      from: "jane@mail.example.com",
      rules: [rule("org", "example.com", "deny"), rule("domain", "mail.example.com", "allow")],
      verdict: "known",
      decidedBy: "domain",
    },
    {
      name: "a denied domain under an allowed parent domain",
      from: "jane@spammy.example.com",
      rules: [rule("org", "example.com", "allow"), rule("domain", "spammy.example.com", "deny")],
      verdict: "reject",
      decidedBy: "domain",
    },
    {
      name: "allow and deny for the same address",
      from: "jane@example.com",
      rules: [rule("address", "jane@example.com", "allow"), rule("address", "jane@example.com", "deny")],
      verdict: "reject",
      decidedBy: "address",
    },
    {
      name: "allow and deny for the same parent at once",
      from: "jane@a.b.example.com",
      rules: [rule("org", "b.example.com", "allow"), rule("org", "example.com", "deny")],
      verdict: "reject",
      decidedBy: "org",
    },
    {
      name: "a parent rule on a deep subdomain",
      from: "x@mail.spammy.example.com",
      rules: [rule("org", "example.com", "deny")],
      verdict: "reject",
      decidedBy: "org",
    },
    {
      name: "a domain rule on a subdomain",
      from: "x@mail.example.com",
      rules: [rule("domain", "example.com", "deny")],
      verdict: "unknown",
    },
    {
      name: "a parent rule on a lookalike domain",
      from: "x@notexample.com",
      rules: [rule("org", "example.com", "deny")],
      verdict: "unknown",
    },
    {
      name: "a co.uk parent rule",
      from: "orders@shop.example.co.uk",
      rules: [rule("org", "example.co.uk", "allow")],
      verdict: "known",
      decidedBy: "org",
    },
    {
      name: "a co.uk parent rule on another co.uk domain",
      from: "orders@other.co.uk",
      rules: [rule("org", "example.co.uk", "allow")],
      verdict: "unknown",
    },
    {
      name: "a +tag on an allowed address",
      from: "Jane <jane+receipts@example.com>",
      rules: [rule("address", "jane@example.com", "allow")],
      verdict: "known",
      decidedBy: "address",
    },
    {
      name: "mixed case on a denied address",
      from: "JANE@Example.COM",
      rules: [rule("address", "jane@example.com", "deny")],
      verdict: "reject",
      decidedBy: "address",
    },
    {
      name: "a spoofed allowlisted sender with dmarc=fail",
      from: "Jane <jane@example.com>",
      authenticationResults: [CLOUDFLARE_FAIL],
      rules: [rule("address", "jane@example.com", "allow")],
      verdict: "unknown",
      decidedBy: "address",
    },
    {
      name: "an allowlisted sender without Authentication-Results",
      from: "Jane <jane@example.com>",
      authenticationResults: [],
      rules: [rule("address", "jane@example.com", "allow")],
      verdict: "unknown",
      decidedBy: "address",
    },
    {
      name: "a denied sender even with dmarc=fail",
      from: "spam@example.com",
      authenticationResults: [CLOUDFLARE_FAIL],
      rules: [rule("address", "spam@example.com", "deny")],
      verdict: "reject",
      decidedBy: "address",
    },
  ])("decides $name: $verdict", ({ from, authenticationResults = [CLOUDFLARE_PASS], rules, verdict, decidedBy }) => {
    expect.hasAssertions();
    const messageHeaders = headers(from, ...authenticationResults);

    const decision = decide(sender(messageHeaders), rules);

    expect(decision.verdict).toBe(verdict);
    expect(decision.rule?.kind).toBe(decidedBy);
  });

  it("ignores a sender-supplied dmarc=pass after Cloudflare's fail on an allowlisted sender", () => {
    expect.hasAssertions();
    const messageHeaders = headers(
      "Jane <jane@example.com>",
      CLOUDFLARE_FAIL,
      "mx.cloudflare.net; dkim=pass; dmarc=pass header.from=example.com",
    );

    const decision = decide(sender(messageHeaders), [rule("address", "jane@example.com", "allow")]);

    expect(decision.verdict).toBe("unknown");
    expect(decision.sender?.dmarc).toBe("fail");
  });

  it("forwards an unreadable From as unknown", () => {
    expect.hasAssertions();

    expect(decide(null, [rule("org", "example.com", "deny")])).toStrictEqual({
      verdict: "unknown",
      sender: null,
      rule: null,
    });
  });
});

describe("normalizePattern", () => {
  it.for<{ kind: RuleKind; pattern: string; normalized: string | null }>([
    { kind: "address", pattern: " Jane+Tag@Example.COM ", normalized: "jane@example.com" },
    { kind: "address", pattern: "example.com", normalized: null },
    { kind: "domain", pattern: "Shop.Example.co.uk.", normalized: "shop.example.co.uk" },
    { kind: "domain", pattern: "@example.com", normalized: "example.com" },
    { kind: "org", pattern: "*.example.com", normalized: "example.com" },
    { kind: "org", pattern: "co.uk", normalized: null },
    { kind: "org", pattern: "com", normalized: null },
    { kind: "domain", pattern: "jane@example.com", normalized: null },
  ])("normalizes $kind $pattern", ({ kind, pattern, normalized }) => {
    expect.hasAssertions();

    expect(normalizePattern(kind, pattern)).toBe(normalized);
  });
});

describe("isFreeMail", () => {
  it.for([
    { from: "someone@gmail.com", free: true },
    { from: "someone@googlemail.com", free: true },
    { from: "someone@proton.me", free: true },
    { from: "someone@hotmail.co.uk", free: true },
    { from: "someone@example.com", free: false },
    { from: "someone@example.co.uk", free: false },
  ])("says $from is free mail: $free", ({ from, free }) => {
    expect.hasAssertions();

    expect(isFreeMail(sender(headers(from)))).toBe(free);
  });
});
