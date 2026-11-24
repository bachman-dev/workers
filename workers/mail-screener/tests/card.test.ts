import {
  type APIContainerComponent,
  ComponentType,
  type DiscordCreateMessageQueueBody,
  type DiscordEditMessageQueueBody,
  type DiscordMessageQueueBody,
} from "@bachman-dev/workers-shared/discord";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import worker, { ScreenerService } from "../src/index.ts";
import type { Sender } from "../src/types/screener.ts";
import { screenerStub, testEnv } from "./env.ts";
import makeSender from "./fixtures.ts";
import FakeEmailMessage from "./message.ts";
import { captureQueue } from "./queue.ts";

vi.setConfig({ testTimeout: 10_000 });

const APP_ID = "100000000000000001";
const CHANNEL_ID = "200000000000000002";

/** A row of buttons as the card shows them. */
interface ButtonRow {
  labels: (string | undefined)[];
  customIds: string[];
}

/**
 * Opens a review for a sender and returns its ID.
 *
 * @param {Sender} sender - The sender.
 * @param {string} subject - The subject.
 * @returns {Promise<string>} The review's ID.
 */
async function openReview(sender: Sender, subject = "Hello"): Promise<string> {
  const { review } = await screenerStub().openReview(sender, subject);
  return review.id;
}

/**
 * Reads the button rows of a card.
 *
 * @param {APIContainerComponent} card - The card.
 * @returns {ButtonRow[]} Each row's labels and custom IDs, in order.
 */
function buttonRows(card: APIContainerComponent): ButtonRow[] {
  return card.components.flatMap((component) => {
    if (component.type !== ComponentType.ActionRow) {
      return [];
    }
    const buttons = component.components.flatMap((child) =>
      child.type === ComponentType.Button && "custom_id" in child ? [child] : [],
    );
    return [{ labels: buttons.map((child) => child.label), customIds: buttons.map((child) => child.custom_id) }];
  });
}

/**
 * Reads a card's text.
 *
 * @param {APIContainerComponent} card - The card.
 * @returns {string} Every text display's content, one per line.
 */
function cardText(card: APIContainerComponent): string {
  return card.components
    .flatMap((component) => (component.type === ComponentType.TextDisplay ? [component.content] : []))
    .join("\n");
}

/**
 * Narrows a queued body to a post.
 *
 * @param {DiscordMessageQueueBody | undefined} body - The queued body.
 * @returns {DiscordCreateMessageQueueBody} The post.
 */
function asPost(body: DiscordMessageQueueBody | undefined): DiscordCreateMessageQueueBody {
  if (body === undefined || !("format" in body) || body.format !== "message") {
    throw new Error("Expected a bot post");
  }
  return body;
}

/**
 * Narrows a queued body to an edit.
 *
 * @param {DiscordMessageQueueBody | undefined} body - The queued body.
 * @returns {DiscordEditMessageQueueBody} The edit.
 */
function asEdit(body: DiscordMessageQueueBody | undefined): DiscordEditMessageQueueBody {
  if (body?.op !== "edit") {
    throw new Error("Expected an edit");
  }
  return body;
}

/**
 * Narrows a card body's component to a container.
 *
 * @param {DiscordCreateMessageQueueBody | DiscordEditMessageQueueBody} body - The queued body.
 * @returns {APIContainerComponent} The card.
 */
function cardOf(body: DiscordCreateMessageQueueBody | DiscordEditMessageQueueBody): APIContainerComponent {
  if (body.component.type !== ComponentType.Container) {
    throw new Error("Expected a container");
  }
  return body.component;
}

/**
 * Fails the test if decide() found no review.
 *
 * @param {APIContainerComponent | null} card - What decide() returned.
 * @returns {APIContainerComponent} The card.
 */
function requireCard(card: APIContainerComponent | null): APIContainerComponent {
  if (card === null) {
    throw new Error("Expected a card");
  }
  return card;
}

describe("review cards", () => {
  it("posts a new review's card by ref at version 1, pinging no one", async () => {
    expect.hasAssertions();
    const queued = captureQueue();

    const reviewId = await openReview(makeSender("jane@example.com", { name: "Jane Doe", dmarc: "fail" }), "Hi");

    expect(queued).toHaveLength(1);
    const post = asPost(queued[0]);
    expect(post).toMatchObject({
      format: "message",
      applicationId: APP_ID,
      channelId: CHANNEL_ID,
      ref: `mail-screener:review:${reviewId}`,
      version: 1,
      allowedMentions: { parse: [] },
      component: { type: ComponentType.Container },
    });
    const text = cardText(cardOf(post));
    expect(text).toContain("`Jane Doe` `jane@example.com`");
    expect(text).toContain("**Subject** `Hi`");
    expect(text).toContain("❌ fail");
    expect(text).toContain("1 message,");
  });

  it("edits the card by the same ref at a rising version for each bump", async () => {
    expect.hasAssertions();
    const queued = captureQueue();
    const sender = makeSender("jane@example.com");

    const reviewId = await openReview(sender);
    await openReview(sender);
    await openReview(sender);

    expect(queued.map((body) => [body.op, body.ref, body.version])).toStrictEqual([
      [undefined, `mail-screener:review:${reviewId}`, 1],
      ["edit", `mail-screener:review:${reviewId}`, 2],
      ["edit", `mail-screener:review:${reviewId}`, 3],
    ]);
    const edit = asEdit(queued[2]);
    expect(edit.allowedMentions).toStrictEqual({ parse: [] });
    expect(cardText(cardOf(edit))).toContain("3 messages,");
  });

  it("offers exact and parent domain buttons for an ordinary domain", async () => {
    expect.hasAssertions();
    const queued = captureQueue();

    const reviewId = await openReview(makeSender("orders@shop.example.co.uk"));

    expect(buttonRows(cardOf(asPost(queued[0])))).toStrictEqual([
      {
        labels: ["Allow sender", "Allow shop.example.co.uk", "Allow example.co.uk"],
        customIds: [
          `screen:allow_sender:${reviewId}`,
          `screen:allow_domain:${reviewId}`,
          `screen:allow_org:${reviewId}`,
        ],
      },
      {
        labels: ["Block sender", "Block shop.example.co.uk", "Block example.co.uk"],
        customIds: [
          `screen:block_sender:${reviewId}`,
          `screen:block_domain:${reviewId}`,
          `screen:block_org:${reviewId}`,
        ],
      },
      { labels: ["Dismiss"], customIds: [`screen:dismiss:${reviewId}`] },
    ]);
  });

  it("offers one domain button per row when the exact domain is the parent domain", async () => {
    expect.hasAssertions();
    const queued = captureQueue();

    const reviewId = await openReview(makeSender("jane@example.com"));

    expect(buttonRows(cardOf(asPost(queued[0])))).toStrictEqual([
      {
        labels: ["Allow sender", "Allow example.com"],
        customIds: [`screen:allow_sender:${reviewId}`, `screen:allow_org:${reviewId}`],
      },
      {
        labels: ["Block sender", "Block example.com"],
        customIds: [`screen:block_sender:${reviewId}`, `screen:block_org:${reviewId}`],
      },
      { labels: ["Dismiss"], customIds: [`screen:dismiss:${reviewId}`] },
    ]);
  });

  it("offers no domain buttons for free mail", async () => {
    expect.hasAssertions();
    const queued = captureQueue();

    const reviewId = await openReview(makeSender("someone@gmail.com"));

    expect(buttonRows(cardOf(asPost(queued[0])))).toStrictEqual([
      { labels: ["Allow sender"], customIds: [`screen:allow_sender:${reviewId}`] },
      { labels: ["Block sender"], customIds: [`screen:block_sender:${reviewId}`] },
      { labels: ["Dismiss"], customIds: [`screen:dismiss:${reviewId}`] },
    ]);
  });

  it("shows message text only as inline code, with no embeds or links", async () => {
    expect.hasAssertions();
    const queued = captureQueue();
    const sender = makeSender("jane@example.com", { name: "@everyone [click](https://evil.example.com)" });

    await openReview(sender, "Reset your password at https://evil.example.com/login `now`");

    const post = asPost(queued[0]);
    const json = JSON.stringify(post);
    expect(json).not.toContain('"embeds"');
    expect(json).not.toContain('"url"');
    const text = cardText(cardOf(post));
    expect(text).toContain("`@everyone [click](https://evil.example.com)`");
    expect(text).toContain("`Reset your password at https://evil.example.com/login ˋnowˋ`");
    // Every https:// sits inside a code span: strip the spans and nothing link-like is left
    expect(text.replaceAll(/`[^`]*`/gv, "")).not.toMatch(/https?:/v);
  });

  it("queues the decided card as an edit above the last bump, without buttons, and returns it", async () => {
    expect.hasAssertions();
    const queued = captureQueue();
    const sender = makeSender("orders@shop.example.co.uk");
    const reviewId = await openReview(sender);
    await openReview(sender);

    const card = await screenerStub().decide(reviewId, "allow_sender");

    expect(queued).toHaveLength(3);
    const edit = asEdit(queued[2]);
    expect(edit.ref).toBe(`mail-screener:review:${reviewId}`);
    expect(edit.version).toBe(3);
    expect(edit.version).toBeGreaterThan(asEdit(queued[1]).version);
    expect(edit.component).toStrictEqual(card);
    expect(buttonRows(cardOf(edit))).toStrictEqual([]);
    expect(cardText(cardOf(edit))).toContain("Sender allowlisted");
    expect(cardText(cardOf(edit))).toContain("2 messages,");
  });

  it.for([
    { action: "allow_domain", line: "`shop.example.co.uk` allowlisted" },
    { action: "allow_org", line: "`example.co.uk` and its subdomains allowlisted" },
    { action: "block_sender", line: "Sender blocked" },
    { action: "block_domain", line: "`shop.example.co.uk` blocked" },
    { action: "block_org", line: "`example.co.uk` and its subdomains blocked" },
    { action: "dismiss", line: "Dismissed" },
  ] as const)("says what $action did", async ({ action, line }) => {
    expect.hasAssertions();
    captureQueue();
    const reviewId = await openReview(makeSender("orders@shop.example.co.uk"));

    const card = await screenerStub().decide(reviewId, action);

    expect(cardText(requireCard(card))).toContain(line);
  });

  it("answers decide() through the ScreenerService entrypoint", async () => {
    expect.hasAssertions();
    const queued = captureQueue();
    const reviewId = await openReview(makeSender("jane@example.com"));

    const service = new ScreenerService(createExecutionContext(), testEnv);

    const card = await service.decide(reviewId, "block_sender");

    expect(card).toStrictEqual(asEdit(queued[1]).component);
    await expect(screenerStub().listSenders()).resolves.toMatchObject([
      { kind: "address", pattern: "jane@example.com", list: "deny" },
    ]);
  });

  it("posts a card when the email handler sees an unknown sender", async () => {
    expect.hasAssertions();
    const queued = captureQueue();
    const message = new FakeEmailMessage({
      headers: {
        from: "Jane <jane@example.com>",
        subject: "Hello",
        "authentication-results": "mx.cloudflare.net; dmarc=pass",
      },
    });

    await worker.email(message, testEnv);

    expect(queued).toHaveLength(1);
    expect(cardText(cardOf(asPost(queued[0])))).toContain("**Subject** `Hello`");
  });
});
