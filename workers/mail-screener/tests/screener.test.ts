import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { screenerStub } from "./env.ts";
import makeSender from "./fixtures.ts";

vi.setConfig({ testTimeout: 10_000 });

describe("sender rules", () => {
  it("lets the very next match() see an added allow rule", async () => {
    expect.hasAssertions();
    const sender = makeSender("jane@example.com");

    await runInDurableObject(screenerStub(), (screener) => {
      expect(screener.match(sender).verdict).toBe("unknown");

      screener.addSender({ kind: "address", pattern: "Jane+Tag@Example.com", list: "allow", addedVia: "seed" });

      expect(screener.match(sender)).toMatchObject({
        verdict: "known",
        rule: { kind: "address", pattern: "jane@example.com", list: "allow" },
      });
    });
  });

  it("matches a parent rule on a deep subdomain through storage", async () => {
    expect.hasAssertions();

    await runInDurableObject(screenerStub(), (screener) => {
      screener.addSender({ kind: "org", pattern: "example.com", list: "deny", addedVia: "cli" });
      screener.addSender({ kind: "address", pattern: "jane@mail.example.com", list: "allow", addedVia: "cli" });

      expect(screener.match(makeSender("x@mail.spammy.example.com")).verdict).toBe("reject");
      expect(screener.match(makeSender("jane@mail.example.com")).verdict).toBe("known");
      expect(screener.match(makeSender("x@notexample.com")).verdict).toBe("unknown");
    });
  });

  it("replaces a rule with the same kind and pattern, and removes it", async () => {
    expect.hasAssertions();

    await runInDurableObject(screenerStub(), (screener) => {
      screener.addSender({ kind: "domain", pattern: "example.com", list: "allow", addedVia: "seed" });
      screener.addSender({ kind: "domain", pattern: "EXAMPLE.com", list: "deny", note: "changed", addedVia: "cli" });

      expect(screener.listSenders()).toMatchObject([
        { kind: "domain", pattern: "example.com", list: "deny", note: "changed", addedVia: "cli" },
      ]);
      expect(screener.listSenders("allow")).toStrictEqual([]);
      expect(screener.removeSender("domain", "example.com")).toBe(true);
      expect(screener.removeSender("domain", "example.com")).toBe(false);
      expect(screener.listSenders()).toStrictEqual([]);
    });
  });

  it("refuses an invalid pattern", async () => {
    expect.hasAssertions();

    await runInDurableObject(screenerStub(), (screener) => {
      expect(() => screener.addSender({ kind: "org", pattern: "co.uk", list: "deny", addedVia: "cli" })).toThrow(
        TypeError,
      );
    });
  });
});

describe("reviews", () => {
  it("bumps the count on a second message from the same unknown sender instead of opening a new review", async () => {
    expect.hasAssertions();
    const sender = makeSender("stranger@example.com", { name: "A Stranger", dmarc: "fail" });

    await runInDurableObject(screenerStub(), (screener) => {
      const first = screener.openReview(sender, "Hello");
      const second = screener.openReview(sender, "Hello again");

      expect(first).toMatchObject({
        created: true,
        review: {
          fromAddr: "stranger@example.com",
          fromName: "A Stranger",
          subject: "Hello",
          count: 1,
          dmarc: "fail",
          cardVersion: 1,
          status: "open",
          decision: null,
          decidedAt: null,
        },
      });
      expect(first.review.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/v);
      expect(second).toStrictEqual({
        created: false,
        review: { ...first.review, count: 2, cardVersion: 2 },
      });
      expect(screener.listOpen()).toStrictEqual([second.review]);
    });
  });

  it("keeps the first 200 characters of the subject", async () => {
    expect.hasAssertions();

    await runInDurableObject(screenerStub(), (screener) => {
      const { review } = screener.openReview(makeSender("a@example.com"), "x".repeat(300));

      expect(review.subject).toHaveLength(200);
    });
  });

  it("adds the action's rule and closes the review", async () => {
    expect.hasAssertions();

    await runInDurableObject(screenerStub(), (screener) => {
      const { review } = screener.openReview(makeSender("orders@shop.example.co.uk"), "Your order");

      const decided = screener.decide(review.id, "block_org");

      expect(decided).toMatchObject({ status: "blocked", decision: "block_org", cardVersion: 2 });
      expect(decided?.decidedAt).toBeTypeOf("number");
      expect(screener.listSenders()).toMatchObject([
        { kind: "org", pattern: "example.co.uk", list: "deny", addedVia: "discord", note: `Review ${review.id}` },
      ]);
      expect(screener.listOpen()).toStrictEqual([]);
      expect(screener.match(makeSender("x@other.example.co.uk")).verdict).toBe("reject");
    });
  });

  it("changes nothing when a review is decided twice", async () => {
    expect.hasAssertions();

    await runInDurableObject(screenerStub(), (screener) => {
      const { review } = screener.openReview(makeSender("jane@example.com"), "Hi");

      const first = screener.decide(review.id, "allow_sender");
      const rules = screener.listSenders();
      const second = screener.decide(review.id, "block_org");

      expect(first).toMatchObject({ status: "allowed", decision: "allow_sender" });
      expect(second).toStrictEqual(first);
      expect(screener.listSenders()).toStrictEqual(rules);
    });
  });

  it("opens a new review once the sender's last one is closed", async () => {
    expect.hasAssertions();
    const sender = makeSender("jane@example.com");

    await runInDurableObject(screenerStub(), (screener) => {
      const first = screener.openReview(sender, "Hi");
      screener.decide(first.review.id, "dismiss");
      const second = screener.openReview(sender, "Hi again");

      expect(screener.listSenders()).toStrictEqual([]);
      expect(second.created).toBe(true);
      expect(second.review.id).not.toBe(first.review.id);
    });
  });

  it("won't add a domain rule for free mail", async () => {
    expect.hasAssertions();

    await runInDurableObject(screenerStub(), (screener) => {
      const { review } = screener.openReview(makeSender("someone@gmail.com"), "Hi");

      expect(() => screener.decide(review.id, "allow_org")).toThrow(TypeError);
      expect(screener.listOpen()).toHaveLength(1);
      expect(screener.listSenders()).toStrictEqual([]);
    });
  });

  it("returns null for an unknown review", async () => {
    expect.hasAssertions();

    await expect(screenerStub().decide("01ARZ3NDEKTSV4RRFFQ69G5FAV", "dismiss")).resolves.toBeNull();
  });
});
