// The contract between mail-screener and the workers that call its ScreenerService entrypoint over a service binding.
import type { APIContainerComponent } from "discord-api-types/v10";

/** What a rule matches: one address, one exact host, or a parent domain and every subdomain under it. */
export type RuleKind = "address" | "domain" | "org";

/** Whether a rule lets mail through or rejects it. */
export type RuleList = "allow" | "deny";

/** Where a sender rule came from. */
export type AddedVia = "discord" | "seed" | "cli";

/** What a review card's buttons can do, in the order the card offers them. */
export const SCREENER_REVIEW_ACTIONS = [
  "allow_sender",
  "allow_domain",
  "allow_org",
  "block_sender",
  "block_domain",
  "block_org",
  "dismiss",
] as const;

/** What a review card's buttons can do. */
export type ReviewAction = (typeof SCREENER_REVIEW_ACTIONS)[number];

/** The longest note ScreenerService accepts on a rule. */
export const SCREENER_MAX_NOTE_LENGTH = 200;

/** A sender rule as matched, with its pattern already normalized. */
export interface SenderRule {
  kind: RuleKind;
  pattern: string;
  list: RuleList;
}

/** A sender rule as stored in the Screener. */
export interface StoredRule extends SenderRule {
  note: string | null;
  /** Unix time in milliseconds. */
  addedAt: number;
  addedVia: AddedVia;
}

/** A sender rule to add; its pattern is normalized before it's stored. */
export interface NewRule extends SenderRule {
  note?: string | null;
  addedVia: AddedVia;
}

/** Where a rule added over ScreenerService can come from; `cli` is kept for tooling that talks to the Screener itself. */
export type ServiceAddedVia = Exclude<AddedVia, "cli">;

/** A sender rule to add over ScreenerService. */
export interface AddSenderRequest extends Omit<NewRule, "addedVia"> {
  addedVia: ServiceAddedVia;
}

/** Which rule a removal names: its kind and normalized pattern. */
export type RuleKey = Pick<SenderRule, "kind" | "pattern">;

/**
 * A request ScreenerService turned down for a reason the caller can show. `reason` is a plain sentence with nothing
 * from the request in it, so it's safe to show as is.
 */
export interface ScreenerRefusal<Code extends string> {
  ok: false;
  code: Code;
  reason: string;
}

/** What adding a rule gives back: the stored rule, or why it wasn't added. */
export type AddSenderResult =
  | { ok: true; rule: StoredRule }
  | ScreenerRefusal<"invalid_pattern">
  | (ScreenerRefusal<"free_mail"> & { rule: RuleKey });

/** What removing a rule gives back: the rule that was removed, or why nothing was. */
export type RemoveSenderResult =
  | { ok: true; rule: RuleKey }
  | ScreenerRefusal<"invalid_pattern">
  | (ScreenerRefusal<"not_found"> & { rule: RuleKey });

/**
 * What mail-screener's ScreenerService entrypoint offers over a service binding, e.g. `{ "binding": "SCREENER",
 * "service": "mail-screener", "entrypoint": "ScreenerService" }`. Every method talks to the one Screener.
 */
export interface ScreenerServiceRpc {
  /**
   * Decides a review, as its card's buttons do.
   *
   * @param {string} reviewId - The review's ID, from the button's custom ID.
   * @param {ReviewAction} action - The action, from the button's custom ID.
   * @returns {Promise<APIContainerComponent | null>} The closed card to update the message with, or `null` if there's
   *   no such review.
   */
  decide: (reviewId: string, action: ReviewAction) => Promise<APIContainerComponent | null>;

  /**
   * Adds a sender rule, or replaces the one with the same kind and pattern on either list.
   *
   * @param {AddSenderRequest} rule - The rule; its pattern is normalized first.
   * @returns {Promise<AddSenderResult>} The stored rule, or why it was refused.
   */
  addSender: (rule: AddSenderRequest) => Promise<AddSenderResult>;

  /**
   * Removes the sender rule with a kind and pattern, whichever list it's on.
   *
   * @param {RuleKind} kind - The rule's kind.
   * @param {string} pattern - The rule's pattern; it's normalized first.
   * @returns {Promise<RemoveSenderResult>} The removed rule, or why nothing was removed.
   */
  removeSender: (kind: RuleKind, pattern: string) => Promise<RemoveSenderResult>;

  /**
   * Lists the sender rules.
   *
   * @param {RuleList | undefined} list - Only this list's rules, or every rule if left out.
   * @returns {Promise<StoredRule[]>} The rules, most specific kind first, then by pattern.
   */
  listSenders: (list?: RuleList) => Promise<StoredRule[]>;
}
