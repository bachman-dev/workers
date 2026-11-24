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
