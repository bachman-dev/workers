/** What a rule matches: one address, one exact host, or a parent domain and every subdomain under it. */
export type RuleKind = "address" | "domain" | "org";

/** Whether a rule lets mail through or rejects it. */
export type RuleList = "allow" | "deny";

/** The DMARC result Cloudflare's own Authentication-Results header gives, or `none` without a trustworthy one. */
export type Dmarc = "pass" | "fail" | "none";

/**
 * What happens to a message: `reject` it (a deny rule matched), forward it as `known` (an allow rule matched and DMARC
 * passed), or forward it as `unknown` for review (everything else).
 */
export type Verdict = "reject" | "known" | "unknown";

/** A sender rule as matched, with its pattern already normalized. */
export interface SenderRule {
  kind: RuleKind;
  pattern: string;
  list: RuleList;
}

/** The sender of a message, from its header From, plus the DMARC result Cloudflare recorded for it. */
export interface Sender {
  /** The address, lowercased and with any `+tag` stripped from the local part. */
  address: string;
  /** The display name, decoded, or `null` if there isn't one. */
  name: string | null;
  /** The exact host after the `@`. */
  domain: string;
  /** The registrable (parent) domain of `domain`, per the Public Suffix List. */
  org: string;
  dmarc: Dmarc;
}

/** The outcome for one message. */
export interface Decision {
  verdict: Verdict;
  /** The parsed sender, or `null` if the header From couldn't be read. */
  sender: Sender | null;
  /** The rule that decided the verdict, if one matched. */
  rule: SenderRule | null;
}

/** Where a sender rule came from. */
export type AddedVia = "discord" | "seed" | "cli";

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

/** Where a review stands. */
export type ReviewStatus = "open" | "allowed" | "blocked" | "dismissed";

/** What a review card's buttons can do. */
export type ReviewAction =
  | "allow_sender"
  | "allow_domain"
  | "allow_org"
  | "block_sender"
  | "block_domain"
  | "block_org"
  | "dismiss";

/** How a review was closed: one of its buttons, or `expire` when nobody decided within the expiry window. */
export type ReviewDecision = ReviewAction | "expire";

/** Mail from one unknown sender waiting for a decision. */
export interface Review {
  /** A ULID, also used in the card's ref and button custom IDs. */
  id: string;
  fromAddr: string;
  fromName: string | null;
  /** The first message's subject, cut to 200 characters. */
  subject: string;
  /** How many messages arrived while the review was open. */
  count: number;
  /** When the first message arrived, as Unix time in milliseconds. */
  receivedAt: number;
  /** The first message's DMARC result. */
  dmarc: Dmarc;
  /** The version of the last card queued for this review. */
  cardVersion: number;
  status: ReviewStatus;
  /** How the review was closed, or `null` while it's open. */
  decision: ReviewDecision | null;
  /** When the review was closed, as Unix time in milliseconds, or `null` while it's open. */
  decidedAt: number | null;
}

/** What opening a review gives back: the review, and whether this message opened it. */
export interface OpenedReview {
  review: Review;
  created: boolean;
}
