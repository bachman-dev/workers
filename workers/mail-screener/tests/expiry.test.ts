import { ComponentType } from "@bachman-dev/workers-shared/discord";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { screenerStub } from "./env.ts";
import makeSender from "./fixtures.ts";
import { captureQueue } from "./queue.ts";

vi.setConfig({ testTimeout: 10_000 });

const DAY_MS = 86_400_000;

/**
 * Moves a review's first message back in time, as if it had been open that long.
 *
 * @param {string} reviewId - The review's ID.
 * @param {number} days - How many days ago it opened.
 * @returns {Promise<void>} Resolves once it's stored.
 */
async function backdate(reviewId: string, days: number): Promise<void> {
  await runInDurableObject(screenerStub(), (_screener, state) => {
    state.storage.sql.exec("UPDATE reviews SET received_at = ? WHERE id = ?", Date.now() - days * DAY_MS, reviewId);
  });
}

/**
 * Reads when the Screener's alarm is set for.
 *
 * @returns {Promise<number | null>} The alarm's time, or `null` if none is set.
 */
async function alarmTime(): Promise<number | null> {
  return await runInDurableObject(screenerStub(), async (_screener, state) => await state.storage.getAlarm());
}

describe("review expiry", () => {
  it("schedules the daily alarm when the first review opens", async () => {
    expect.hasAssertions();
    captureQueue();
    await expect(alarmTime()).resolves.toBeNull();
    const before = Date.now();

    await screenerStub().openReview(makeSender("jane@example.com"), "Hi");

    const scheduled = await alarmTime();
    expect(scheduled).toBeGreaterThanOrEqual(before + DAY_MS);
    expect(scheduled).toBeLessThanOrEqual(Date.now() + DAY_MS);
  });

  it("dismisses a review open 14 days or more and queues its card as an edit", async () => {
    expect.hasAssertions();
    const queued = captureQueue();
    const stub = screenerStub();
    const sender = makeSender("old@example.com");
    const { review: old } = await stub.openReview(sender, "Old news");
    await stub.openReview(sender, "Old news again");
    const { review: fresh } = await stub.openReview(makeSender("new@example.com"), "Fresh");
    await backdate(old.id, 14);
    await backdate(fresh.id, 13);
    const sends = queued.length;

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await expect(stub.listOpen()).resolves.toMatchObject([{ id: fresh.id }]);
    expect(queued.slice(sends)).toMatchObject([
      { op: "edit", ref: `mail-screener:review:${old.id}`, version: 3, allowedMentions: { parse: [] } },
    ]);
    const [edit] = queued.slice(sends);
    expect(JSON.stringify(edit)).toContain("Dismissed after 14 days");
    expect(JSON.stringify(edit)).not.toContain(`"type":${ComponentType.Button}`);
    // A fresh review is still open, so the alarm runs again tomorrow
    await expect(alarmTime()).resolves.toBeGreaterThan(Date.now());
  });

  it("returns the expired card if someone presses a button on it later", async () => {
    expect.hasAssertions();
    const queued = captureQueue();
    const stub = screenerStub();
    const { review } = await stub.openReview(makeSender("old@example.com"), "Old news");
    await backdate(review.id, 20);
    await runDurableObjectAlarm(stub);
    const sends = queued.length;

    const card = await stub.decide(review.id, "allow_sender");

    expect(JSON.stringify(card)).toContain("Dismissed after 14 days");
    expect(queued).toHaveLength(sends);
    await expect(stub.listSenders()).resolves.toStrictEqual([]);
  });

  it("stops the alarm once no reviews are open", async () => {
    expect.hasAssertions();
    captureQueue();
    const stub = screenerStub();
    const { review } = await stub.openReview(makeSender("old@example.com"), "Old news");
    await backdate(review.id, 14);

    await runDurableObjectAlarm(stub);

    await expect(stub.listOpen()).resolves.toStrictEqual([]);
    await expect(alarmTime()).resolves.toBeNull();
  });
});
