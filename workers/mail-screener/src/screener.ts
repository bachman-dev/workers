import { DurableObject } from "cloudflare:workers";

import { decide, isFreeMail, normalizePattern, orgDomain } from "./decide.ts";
import { truncate } from "./mime.ts";
import ScreenerStorage from "./storage.ts";
import type { Env } from "./types/cloudflare.ts";
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
} from "./types/screener.ts";
import ulid from "./ulid.ts";

/** What a review action does: the rule it adds, if any, and the status it leaves the review in. */
interface ActionEffect {
  rule: { kind: RuleKind; list: RuleList } | null;
  status: Exclude<ReviewStatus, "open">;
}

/** The longest subject a review keeps. */
const MAX_SUBJECT_LENGTH = 200;

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
   * Opens a review for mail from an unknown sender, or counts another message on the sender's open review and raises
   * its card version.
   *
   * @param {Sender} sender - The sender.
   * @param {string} subject - The message's decoded subject; only the first message's is kept.
   * @returns {OpenedReview} The review, and whether this message opened it.
   */
  public openReview(sender: Sender, subject: string): OpenedReview {
    return this.storage.transaction(() => {
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
  }

  /**
   * Decides an open review: adds the action's rule (marked as added from Discord) and closes the review. Deciding a
   * review that's already closed changes nothing.
   *
   * @param {string} reviewId - The review's ID.
   * @param {ReviewAction} action - What to do.
   * @returns {Review | null} The closed review, or `null` if there's no review with that ID.
   */
  public decide(reviewId: string, action: ReviewAction): Review | null {
    if (!isReviewAction(action)) {
      throw new TypeError(`Unknown review action: ${String(action)}`);
    }
    return this.storage.transaction(() => {
      const review = this.storage.getReview(reviewId);
      if (review?.status !== "open") {
        return review;
      }
      const effect = ACTION_EFFECTS[action];
      if (effect.rule !== null) {
        const pattern = patternFor(effect.rule.kind, review.fromAddr);
        if (effect.rule.kind !== "address" && isFreeMail({ domain: pattern, org: orgDomain(pattern) })) {
          throw new TypeError(`Won't add a ${effect.rule.kind} rule for free-mail domain ${pattern}`);
        }
        this.addSender({ ...effect.rule, pattern, note: `Review ${review.id}`, addedVia: "discord" });
      }
      return this.storage.closeReview(review.id, effect.status, action, Date.now());
    });
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
