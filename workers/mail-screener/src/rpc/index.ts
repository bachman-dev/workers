import type { APIContainerComponent } from "@bachman-dev/workers-shared/discord";
import {
  type AddSenderRequest,
  type AddSenderResult,
  type RemoveSenderResult,
  SCREENER_MAX_NOTE_LENGTH,
  type ScreenerServiceRpc,
  type ServiceAddedVia,
} from "@bachman-dev/workers-shared/screener";
import { WorkerEntrypoint } from "cloudflare:workers";

import { SCREENED_DOMAIN } from "../durable/screener/constants.ts";
import { RULE_KINDS, isFreeMail, normalizePattern, orgDomain } from "../durable/screener/decide.ts";
import type { Env } from "../types/cloudflare.ts";
import type { ReviewAction, RuleKind, RuleList, StoredRule } from "../types/screener.ts";

const RULE_LISTS: readonly RuleList[] = ["allow", "deny"];

/** Where a rule added through this entrypoint can come from; `cli` is for tooling that talks to the Screener itself. */
const SERVICE_ADDED_VIA: readonly ServiceAddedVia[] = ["discord", "seed"];

/**
 * Checks that a value from an RPC caller is one of a set of strings.
 *
 * @param {readonly T[]} allowed - The strings it may be.
 * @param {unknown} value - The value.
 * @returns {boolean} Whether it's one of them.
 */
function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return allowed.some((item) => item === value);
}

/**
 * Checks a rule kind from an RPC caller.
 *
 * @param {unknown} kind - The value.
 * @returns {RuleKind} The kind.
 * @throws {TypeError} If it isn't a rule kind.
 */
function requireKind(kind: unknown): RuleKind {
  if (!isOneOf(RULE_KINDS, kind)) {
    throw new TypeError(`Unknown rule kind: ${String(kind)}`);
  }
  return kind;
}

/**
 * Checks a pattern from an RPC caller.
 *
 * @param {unknown} pattern - The value.
 * @returns {string} The pattern, not yet normalized.
 * @throws {TypeError} If it isn't a string.
 */
function requirePattern(pattern: unknown): string {
  if (typeof pattern !== "string") {
    throw new TypeError("A rule's pattern must be a string");
  }
  return pattern;
}

/**
 * Checks a list from an RPC caller.
 *
 * @param {unknown} list - The value.
 * @returns {RuleList} The list.
 * @throws {TypeError} If it isn't a rule list.
 */
function requireList(list: unknown): RuleList {
  if (!isOneOf(RULE_LISTS, list)) {
    throw new TypeError(`Unknown rule list: ${String(list)}`);
  }
  return list;
}

/**
 * Checks a rule to add from an RPC caller, field by field.
 *
 * @param {unknown} rule - The value.
 * @returns {Required<AddSenderRequest>} The rule, with a missing or blank note as `null`.
 * @throws {TypeError} If it isn't an object, or any field is missing, of the wrong type, or not a known value.
 */
function requireNewRule(rule: unknown): Required<AddSenderRequest> {
  if (typeof rule !== "object" || rule === null) {
    throw new TypeError("A rule must be an object");
  }
  const kind = "kind" in rule ? rule.kind : undefined;
  const pattern = "pattern" in rule ? rule.pattern : undefined;
  const list = "list" in rule ? rule.list : undefined;
  const note = "note" in rule ? rule.note : undefined;
  const addedVia = "addedVia" in rule ? rule.addedVia : undefined;
  if (!isOneOf(SERVICE_ADDED_VIA, addedVia)) {
    throw new TypeError(`Rules added through ScreenerService must come from discord or seed, not ${String(addedVia)}`);
  }
  if (note !== undefined && note !== null && typeof note !== "string") {
    throw new TypeError("A rule's note must be a string");
  }
  if (typeof note === "string" && note.length > SCREENER_MAX_NOTE_LENGTH) {
    throw new TypeError(`A rule's note can be at most ${SCREENER_MAX_NOTE_LENGTH} characters`);
  }
  return {
    kind: requireKind(kind),
    pattern: requirePattern(pattern),
    list: requireList(list),
    note: typeof note === "string" && note.trim() !== "" ? note.trim() : null,
    addedVia,
  };
}

/**
 * Explains why a pattern was refused.
 *
 * @param {RuleKind} kind - The rule's kind.
 * @returns {string} A sentence to show the caller.
 */
function invalidPatternReason(kind: RuleKind): string {
  switch (kind) {
    case "address":
      return "That isn't a valid email address.";
    case "domain":
      return "That isn't a valid domain.";
    case "org":
      return "That isn't a valid parent domain.";
  }
}

/**
 * What other workers call over a service binding. bona-fide-bot binds it to answer review buttons and edit the sender
 * lists, with `{ "binding": "SCREENER", "service": "mail-screener", "entrypoint": "ScreenerService" }`. Arguments come
 * from another worker, so each is checked here; expected refusals come back as results, and bad arguments throw.
 */
export default class ScreenerService extends WorkerEntrypoint<Env> implements ScreenerServiceRpc {
  /**
   * Decides a review, as its card's buttons do.
   *
   * @param {string} reviewId - The review's ID, from the button's custom ID.
   * @param {ReviewAction} action - The action, from the button's custom ID.
   * @returns {Promise<APIContainerComponent | null>} The closed card to update the message with, or `null` if there's
   *   no such review.
   */
  public async decide(reviewId: string, action: ReviewAction): Promise<APIContainerComponent | null> {
    return await this.env.SCREENER.getByName(SCREENED_DOMAIN).decide(reviewId, action);
  }

  /**
   * Adds a sender rule, or replaces the one with the same kind and pattern on either list. Refuses an invalid pattern,
   * and a domain or org rule for free mail, which would cover strangers.
   *
   * @param {AddSenderRequest} rule - The rule; its pattern is normalized first, and `addedVia` must be `discord` or
   *   `seed`.
   * @returns {Promise<AddSenderResult>} The stored rule, or why it was refused.
   * @throws {TypeError} If any field is missing, of the wrong type, or not a known value, or the note is too long.
   */
  public async addSender(rule: AddSenderRequest): Promise<AddSenderResult> {
    const checked = requireNewRule(rule);
    const pattern = normalizePattern(checked.kind, checked.pattern);
    if (pattern === null) {
      return { ok: false, code: "invalid_pattern", reason: invalidPatternReason(checked.kind) };
    }
    // The same check decide() makes before adding a domain or org rule from a review
    if (checked.kind !== "address" && isFreeMail({ domain: pattern, org: orgDomain(pattern) })) {
      return {
        ok: false,
        code: "free_mail",
        reason: `That's a free-mail domain, so a ${checked.kind} rule would cover strangers. Add the address instead.`,
        rule: { kind: checked.kind, pattern },
      };
    }
    const stored = await this.env.SCREENER.getByName(SCREENED_DOMAIN).addSender({ ...checked, pattern });
    return { ok: true, rule: stored };
  }

  /**
   * Removes the sender rule with a kind and pattern, whichever list it's on.
   *
   * @param {RuleKind} kind - The rule's kind.
   * @param {string} pattern - The rule's pattern; it's normalized first.
   * @returns {Promise<RemoveSenderResult>} The removed rule, or why nothing was removed.
   * @throws {TypeError} If the kind isn't a rule kind or the pattern isn't a string.
   */
  public async removeSender(kind: RuleKind, pattern: string): Promise<RemoveSenderResult> {
    const checkedKind = requireKind(kind);
    const normalized = normalizePattern(checkedKind, requirePattern(pattern));
    if (normalized === null) {
      return { ok: false, code: "invalid_pattern", reason: invalidPatternReason(checkedKind) };
    }
    const key = { kind: checkedKind, pattern: normalized };
    const removed = await this.env.SCREENER.getByName(SCREENED_DOMAIN).removeSender(checkedKind, normalized);
    return removed
      ? { ok: true, rule: key }
      : { ok: false, code: "not_found", reason: "There's no rule for that.", rule: key };
  }

  /**
   * Lists the sender rules.
   *
   * @param {RuleList | undefined} list - Only this list's rules, or every rule if left out.
   * @returns {Promise<StoredRule[]>} The rules, most specific kind first, then by pattern.
   * @throws {TypeError} If `list` is given and isn't a rule list.
   */
  public async listSenders(list?: RuleList): Promise<StoredRule[]> {
    const stub = this.env.SCREENER.getByName(SCREENED_DOMAIN);
    return await (list === undefined ? stub.listSenders() : stub.listSenders(requireList(list)));
  }
}
