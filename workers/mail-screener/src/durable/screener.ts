import type { APIContainerComponent } from "@bachman-dev/workers-shared/discord";
import { log } from "@bachman-dev/workers-shared/util";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../types/cloudflare.ts";
import type {
  Decision,
  NewRule,
  OpenedReview,
  Review,
  ReviewAction,
  ReviewStatus,
  RuleKind,
  RuleList,
  Sender,
  StoredRule,
} from "../types/screener.ts";
import { buildCard, cardEdit, cardPost } from "./screener/card.ts";
import {
  DAY_MS,
  EXPIRY_BATCH_SIZE,
  MAX_SUBJECT_LENGTH,
  REVIEW_EXPIRY_DAYS,
  REVIEW_EXPIRY_MS,
} from "./screener/constants.ts";
import { decide, isFreeMail, normalizePattern, orgDomain } from "./screener/decide.ts";
import { truncate } from "./screener/mime.ts";
import ScreenerStorage from "./screener/storage.ts";
import ulid from "./screener/ulid.ts";

/** What a review action does: the rule it adds, if any, and the status it leaves the review in. */
interface ActionEffect {
  rule: { kind: RuleKind; list: RuleList } | null;
  status: Exclude<ReviewStatus, "open">;
}

const ACTION_EFFECTS: Readonly<Record<ReviewAction, ActionEffect>> = {
  allow_sender: { rule: { kind: "address", list: "allow" }, status: "allowed" },
  allow_domain: { rule: { kind: "domain", list: "allow" }, status: "allowed" },
  allow_org: { rule: { kind: "org", list: "allow" }, status: "allowed" },
  block_sender: { rule: { kind: "address", list: "deny" }, status: "blocked" },
  block_domain: { rule: { kind: "domain", list: "deny" }, status: "blocked" },
  block_org: { rule: { kind: "org", list: "deny" }, status: "blocked" },
  dismiss: { rule: null, status: "dismissed" },
};

/**
 * Checks that a value from an RPC caller is a review action.
 *
 * @param {unknown} action - The value.
 * @returns {boolean} Whether it's one of the card's actions.
 */
function isReviewAction(action: unknown): action is ReviewAction {
  return typeof action === "string" && Object.hasOwn(ACTION_EFFECTS, action);
}

/**
 * Finds the pattern a rule of a kind needs to cover a reviewed sender.
 *
 * @param {RuleKind} kind - The rule's kind.
 * @param {string} fromAddr - The sender's normalized address.
 * @returns {string} The address, its exact host, or its parent domain.
 */
function patternFor(kind: RuleKind, fromAddr: string): string {
  const domain = fromAddr.slice(fromAddr.lastIndexOf("@") + 1);
  switch (kind) {
    case "address":
      return fromAddr;
    case "domain":
      return domain;
    case "org":
      return orgDomain(domain);
  }
}

/**
 * Holds the sender rules and the reviews of unknown senders for the screened domain. The worker uses one instance,
 * named for the domain, so every message sees every rule.
 */
export default class Screener extends DurableObject<Env> {
  private readonly storage: ScreenerStorage;

  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = new ScreenerStorage(ctx.storage);
    this.storage.migrate();
  }

  /**
   * Decides what happens to mail from a sender, against the stored rules.
   *
   * @param {Sender} sender - The sender, parsed from the message's headers.
   * @returns {Decision} The verdict and the rule that decided it.
   */
  public match(sender: Sender): Decision {
    return decide(sender, this.storage.rulesFor(sender));
  }

  /**
   * Adds a sender rule, or replaces the one with the same kind and pattern.
   *
   * @param {NewRule} rule - The rule; its pattern is normalized first.
   * @returns {StoredRule} The stored rule.
   */
  public addSender(rule: NewRule): StoredRule {
    const pattern = normalizePattern(rule.kind, rule.pattern);
    if (pattern === null) {
      throw new TypeError(`Not a valid ${rule.kind} pattern: ${rule.pattern}`);
    }
    return this.storage.putRule({
      kind: rule.kind,
      pattern,
      list: rule.list,
      note: rule.note ?? null,
      addedAt: Date.now(),
      addedVia: rule.addedVia,
    });
  }

  /**
   * Removes a sender rule.
   *
   * @param {RuleKind} kind - The rule's kind.
   * @param {string} pattern - The rule's pattern; it's normalized first.
   * @returns {boolean} Whether there was a rule to remove.
   */
  public removeSender(kind: RuleKind, pattern: string): boolean {
    const normalized = normalizePattern(kind, pattern);
    return normalized !== null && this.storage.deleteRule(kind, normalized);
  }

  /**
   * Lists the sender rules.
   *
   * @param {RuleList | undefined} list - Only this list's rules, or every rule if left out.
   * @returns {StoredRule[]} The rules, most specific kind first.
   */
  public listSenders(list?: RuleList): StoredRule[] {
    return this.storage.listRules(list);
  }

  /**
   * Opens a review for mail from an unknown sender and queues its card, or counts another message on the sender's open
   * review and queues the updated card at a higher version.
   *
   * @param {Sender} sender - The sender.
   * @param {string} subject - The message's decoded subject; only the first message's is kept.
   * @returns {Promise<OpenedReview>} The review, and whether this message opened it.
   * @throws {Error} If the card couldn't be queued. A new review is discarded then, so the next message retries it.
   */
  public async openReview(sender: Sender, subject: string): Promise<OpenedReview> {
    // Storage calls are synchronous, so no other message can open a second review for this sender in between
    const opened = this.storage.transaction((): OpenedReview => {
      const open = this.storage.getOpenReview(sender.address);
      if (open !== null) {
        return { review: this.storage.bumpReview(open.id), created: false };
      }
      const now = Date.now();
      const review: Review = {
        id: ulid(now),
        fromAddr: sender.address,
        fromName: sender.name,
        subject: truncate(subject, MAX_SUBJECT_LENGTH),
        count: 1,
        receivedAt: now,
        dmarc: sender.dmarc,
        cardVersion: 1,
        status: "open",
        decision: null,
        decidedAt: null,
      };
      this.storage.insertReview(review);
      return { review, created: true };
    });

    const { review, created } = opened;
    if (created && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    }
    try {
      await this.env.DISCORD_QUEUE.send(created ? cardPost(review, this.env) : cardEdit(review), {
        contentType: "json",
      });
    } catch (error) {
      if (created) {
        this.storage.discardUnpostedReview(review.id);
      }
      throw error;
    }
    return opened;
  }

  /**
   * Decides an open review: adds the action's rule (marked as added from Discord), closes the review, and queues the
   * closed card as an edit at a higher version. Deciding a review that's already closed changes nothing and returns the
   * same card.
   *
   * @param {string} reviewId - The review's ID.
   * @param {ReviewAction} action - What to do.
   * @returns {Promise<APIContainerComponent | null>} The closed card, which the bot can answer the button press with,
   *   or `null` if there's no review with that ID.
   */
  public async decide(reviewId: string, action: ReviewAction): Promise<APIContainerComponent | null> {
    if (!isReviewAction(action)) {
      throw new TypeError(`Unknown review action: ${String(action)}`);
    }
    const decided = this.storage.transaction((): { review: Review | null; changed: boolean } => {
      const review = this.storage.getReview(reviewId);
      if (review?.status !== "open") {
        return { review, changed: false };
      }
      const effect = ACTION_EFFECTS[action];
      if (effect.rule !== null) {
        const pattern = patternFor(effect.rule.kind, review.fromAddr);
        if (effect.rule.kind !== "address" && isFreeMail({ domain: pattern, org: orgDomain(pattern) })) {
          throw new TypeError(`Won't add a ${effect.rule.kind} rule for free-mail domain ${pattern}`);
        }
        this.addSender({ ...effect.rule, pattern, note: `Review ${review.id}`, addedVia: "discord" });
      }
      return { review: this.storage.closeReview(review.id, effect.status, action, Date.now()), changed: true };
    });

    const { review, changed } = decided;
    if (review === null) {
      return null;
    }
    if (changed) {
      try {
        await this.env.DISCORD_QUEUE.send(cardEdit(review), { contentType: "json" });
      } catch (error) {
        // The decision stands, and the bot updates the card itself with what this returns
        log("error", `Couldn't queue the closed card for review ${review.id}`, error);
      }
    }
    return buildCard(review);
  }

  /**
   * Runs daily while reviews are open: dismisses every review open for 14 days or more and queues each closed card as
   * an edit at a higher version, then re-arms itself if any reviews are still open.
   *
   * @returns {Promise<void>} Resolves once expired reviews are closed and their cards queued.
   */
  public override async alarm(): Promise<void> {
    const now = Date.now();
    const expired = this.storage.transaction(() =>
      this.storage
        .listOpenReviews(now - REVIEW_EXPIRY_MS)
        .flatMap((review) => this.storage.closeReview(review.id, "dismissed", "expire", now) ?? []),
    );
    for (let start = 0; start < expired.length; start += EXPIRY_BATCH_SIZE) {
      const batch = expired.slice(start, start + EXPIRY_BATCH_SIZE);
      try {
        // oxlint-disable-next-line no-await-in-loop -- Batches are sent in order
        await this.env.DISCORD_QUEUE.sendBatch(
          batch.map((review) => {
            return { body: cardEdit(review), contentType: "json" };
          }),
        );
      } catch (error) {
        // The reviews stay dismissed; a button press on a stale card still gets the closed card from decide()
        log("error", `Couldn't queue ${batch.length} expired review cards`, error);
      }
    }
    if (expired.length > 0) {
      log("info", `Dismissed ${expired.length} reviews open for ${REVIEW_EXPIRY_DAYS} days or more`);
    }
    if (this.storage.listOpenReviews().length > 0) {
      await this.ctx.storage.setAlarm(now + DAY_MS);
    }
  }

  /**
   * Lists the open reviews.
   *
   * @returns {Review[]} The open reviews, oldest first.
   */
  public listOpen(): Review[] {
    return this.storage.listOpenReviews();
  }
}
