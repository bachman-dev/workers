// Decides what happens to a message from its headers and the sender rules, without touching any binding.
import { getDomain } from "tldts";

import { decodeHeaderText } from "./mime.ts";
import type { Decision, Dmarc, RuleKind, Sender, SenderRule } from "./types/screener.ts";

/** Where the scanner is while walking structured header text. */
interface ScanState {
  quoted: boolean;
  commentDepth: number;
  angled: boolean;
  escaped: boolean;
}

/** A header split into the text outside its comments, and each top-level comment's contents. */
interface Uncommented {
  text: string;
  comments: string[];
}

/** Rule kinds from most to least specific; the first kind with a match decides. */
const RULE_KINDS: readonly RuleKind[] = ["address", "domain", "org"];

/** The authserv-id Cloudflare Email Routing stamps on the Authentication-Results header it adds. */
const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

/** Free-mail providers, where a domain rule would cover strangers. Review cards for these only offer sender buttons. */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "aol.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.co.uk",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "tuta.io",
  "tutanota.com",
  "yahoo.co.uk",
  "yahoo.com",
  "yandex.com",
  "ymail.com",
  "zoho.com",
]);

/**
 * Moves the scanner past one character of structured header text.
 *
 * @param {ScanState} state - The scanner's state, updated in place.
 * @param {string} character - The next character.
 * @param {boolean} angles - Whether `<...>` counts as nested, as it does in an address list.
 * @returns {boolean} Whether the character sits outside quoted strings, comments and (optionally) angle brackets. An
 *   opening `<` counts as outside, so callers can find it.
 */
function scanCharacter(state: ScanState, character: string, angles: boolean): boolean {
  if (state.escaped) {
    state.escaped = false;
  } else if ((state.quoted || state.commentDepth > 0) && character === "\\") {
    state.escaped = true;
  } else if (state.quoted) {
    state.quoted = character !== '"';
  } else if (state.commentDepth > 0) {
    if (character === "(") {
      state.commentDepth += 1;
    } else if (character === ")") {
      state.commentDepth -= 1;
    }
  } else if (state.angled) {
    state.angled = character !== ">";
  } else if (character === '"') {
    state.quoted = true;
  } else if (character === "(") {
    state.commentDepth = 1;
  } else {
    state.angled = angles && character === "<";
    return true;
  }
  return false;
}

/**
 * Finds the characters of structured header text that sit outside quoted strings, comments and (optionally) angle
 * brackets, so separators inside those are never mistaken for real ones. Every separator is ASCII, so scanning UTF-16
 * code units is safe.
 *
 * @param {string} text - The header text.
 * @param {boolean} angles - Whether `<...>` counts as nested.
 * @returns {number[]} The index of each top-level character.
 */
function topLevelIndexes(text: string, angles: boolean): number[] {
  const state: ScanState = { quoted: false, commentDepth: 0, angled: false, escaped: false };
  const indexes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (scanCharacter(state, text.charAt(index), angles)) {
      indexes.push(index);
    }
  }
  return indexes;
}

/**
 * Splits structured header text at a separator, ignoring separators in quoted strings, comments and angle brackets.
 *
 * @param {string} text - The header text.
 * @param {string} separator - A single separator character, e.g. `,` or `;`.
 * @param {boolean} angles - Whether `<...>` counts as nested.
 * @returns {string[]} The pieces, untrimmed.
 */
function splitTopLevel(text: string, separator: string, angles: boolean): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (const index of topLevelIndexes(text, angles)) {
    if (text.charAt(index) === separator) {
      pieces.push(text.slice(start, index));
      start = index + 1;
    }
  }
  pieces.push(text.slice(start));
  return pieces;
}

/**
 * Separates comments from the rest of structured header text.
 *
 * @param {string} text - The header text.
 * @returns {Uncommented} The text without comments, and each top-level comment's contents.
 */
function stripComments(text: string): Uncommented {
  const state: ScanState = { quoted: false, commentDepth: 0, angled: false, escaped: false };
  const comments: string[] = [];
  let kept = "";
  let comment = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    const depthBefore = state.commentDepth;
    const escapedBefore = state.escaped;
    scanCharacter(state, character, false);
    if (depthBefore === 0 && state.commentDepth === 0) {
      kept += character;
    } else if (depthBefore > 0 && state.commentDepth === 0) {
      comments.push(comment);
      comment = "";
    } else if (depthBefore > 0 && (escapedBefore || !state.escaped)) {
      // Inside a comment: keep everything but the comment's own escapes
      comment += character;
    }
  }
  if (state.commentDepth > 0) {
    comments.push(comment);
  }
  return { text: kept, comments };
}

/**
 * Removes quoting from a display name: drops the quote marks and resolves backslash escapes inside them.
 *
 * @param {string} text - The display name as written, without comments.
 * @returns {string} The plain name.
 */
function unquote(text: string): string {
  let plain = "";
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      escaped = false;
      plain += character;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else {
      plain += character;
    }
  }
  return plain;
}

/**
 * Splits one mailbox into its address and display name, before either is cleaned up.
 *
 * @param {string} mailbox - One mailbox from an address list, e.g. `"Doe, Jane" <jane@example.com>`.
 * @returns {{ rawAddress: string; rawName: string }} The address without comments, and the unquoted name.
 */
function splitMailbox(mailbox: string): { rawAddress: string; rawName: string } {
  const angle = topLevelIndexes(mailbox, true).find((index) => mailbox.charAt(index) === "<");
  if (angle === undefined) {
    // The bare form, `jane@example.com (Jane Doe)`, puts the name in a comment
    const { text, comments } = stripComments(mailbox);
    return { rawAddress: text, rawName: comments.join(" ") };
  }
  const rest = mailbox.slice(angle + 1);
  const close = rest.indexOf(">");
  return {
    rawAddress: stripComments(close === -1 ? rest : rest.slice(0, close)).text,
    rawName: unquote(stripComments(mailbox.slice(0, angle)).text),
  };
}

/**
 * Finds the parent domain of a host with the Public Suffix List, so `shop.example.co.uk` gives `example.co.uk`. Private
 * suffixes count too, so one `github.io` site isn't the parent of every other.
 *
 * @param {string} host - A lowercased host.
 * @returns {string} The registrable domain, or the host itself if it has none (e.g. an address literal).
 */
export function orgDomain(host: string): string {
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/**
 * Lowercases an address and strips a `+tag` from its local part.
 *
 * @param {string} address - An address with an `@` that separates a local part from a host.
 * @returns {string | null} The normalized address, or `null` if it isn't an address.
 */
export function normalizeAddress(address: string): string | null {
  const trimmed = address.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1 || /\s/v.test(trimmed)) {
    return null;
  }
  const local = trimmed.slice(0, atIndex);
  const host = trimmed.slice(atIndex + 1).replace(/\.$/v, "");
  if (host === "" || !host.includes(".")) {
    return null;
  }
  const [untagged = ""] = local.split("+");
  return `${untagged === "" ? local : untagged}@${host}`;
}

/**
 * Normalizes a rule's pattern the way senders are normalized, and refuses patterns that could never be meant: a
 * malformed address, or a domain rule for a bare public suffix like `co.uk`.
 *
 * @param {RuleKind} kind - The rule's kind.
 * @param {string} pattern - The pattern as typed.
 * @returns {string | null} The normalized pattern, or `null` if it isn't valid for `kind`.
 */
export function normalizePattern(kind: RuleKind, pattern: string): string | null {
  if (kind === "address") {
    return normalizeAddress(pattern);
  }
  const host = pattern.trim().toLowerCase().replace(/^@/v, "").replace(/^\*\./v, "").replace(/\.$/v, "");
  if (host === "" || /[\s@\/]/v.test(host) || !host.includes(".")) {
    return null;
  }
  if (getDomain(host, { allowPrivateDomains: true }) === null) {
    return null;
  }
  return host;
}

/**
 * Parses the first mailbox of a header From: its address and display name. Handles quoted names with commas and angle
 * brackets, comments, the bare `user@host (Name)` form, and RFC 2047 encoded names.
 *
 * @param {string} from - The header From's value.
 * @returns {Pick<Sender, "address" | "name"> | null} The normalized address and decoded name, or `null` if no address
 *   can be read.
 */
export function parseFrom(from: string): Pick<Sender, "address" | "name"> | null {
  const [mailbox = ""] = splitTopLevel(from, ",", true);
  const { rawAddress, rawName } = splitMailbox(mailbox);

  const address = normalizeAddress(rawAddress.replaceAll(/\s+/gv, ""));
  if (address === null) {
    return null;
  }
  const name = decodeHeaderText(rawName);
  return { address, name: name === "" ? null : name };
}

/**
 * Reads the DMARC result from Cloudflare's own Authentication-Results header. Cloudflare prepends its header, so only
 * the leading value counts; `Headers.get()` joins repeated headers with ", ", and any later value was written by the
 * sender or a relay and is ignored. RFC 8601 values only allow commas inside comments and quoted strings, so the first
 * top-level comma ends the leading value.
 *
 * @param {string | null} authenticationResults - The joined Authentication-Results headers, or `null` if there are
 *   none.
 * @returns {Dmarc} The DMARC result, or `none` if there's no leading header from mx.cloudflare.net or it has no DMARC
 *   result.
 */
export function readDmarc(authenticationResults: string | null): Dmarc {
  if (authenticationResults === null) {
    return "none";
  }
  const [leading = ""] = splitTopLevel(authenticationResults, ",", false);
  const [authserv = "", ...results] = splitTopLevel(leading, ";", false);
  // The authserv-id may be followed by a version number
  const [authservId] = stripComments(authserv).text.trim().split(/\s+/v);
  if (authservId?.toLowerCase() !== CLOUDFLARE_AUTHSERV_ID) {
    return "none";
  }
  for (const result of results) {
    const match = /^dmarc\s*=\s*(?<value>[a-z]+)/iv.exec(stripComments(result).text.trim());
    const value = match?.groups?.value?.toLowerCase();
    if (value !== undefined) {
      return value === "pass" || value === "fail" ? value : "none";
    }
  }
  return "none";
}

/**
 * Builds the sender of a message from its header From (not the envelope from) and Authentication-Results.
 *
 * @param {Headers} headers - The message's headers.
 * @returns {Sender | null} The sender, or `null` if the header From is missing or has no readable address.
 */
export function parseSender(headers: Headers): Sender | null {
  const from = headers.get("from");
  const mailbox = from === null ? null : parseFrom(from);
  if (mailbox === null) {
    return null;
  }
  const domain = mailbox.address.slice(mailbox.address.lastIndexOf("@") + 1);
  return {
    address: mailbox.address,
    name: mailbox.name,
    domain,
    org: orgDomain(domain),
    dmarc: readDmarc(headers.get("authentication-results")),
  };
}

/**
 * Lists a host and every parent of it, which are the patterns an `org` rule could have to match it.
 *
 * @param {string} host - A lowercased host, e.g. `mail.example.com`.
 * @returns {string[]} The host and its parents, e.g. `mail.example.com`, `example.com` and `com`.
 */
export function hostSuffixes(host: string): string[] {
  const labels = host.split(".");
  return labels.map((_label, index) => labels.slice(index).join("."));
}

/**
 * Checks whether a rule matches a sender.
 *
 * @param {SenderRule} rule - The rule.
 * @param {Sender} sender - The sender.
 * @returns {boolean} Whether the rule's pattern covers the sender's address, host or parent domain.
 */
export function ruleMatches(rule: SenderRule, sender: Sender): boolean {
  switch (rule.kind) {
    case "address":
      return rule.pattern === sender.address;
    case "domain":
      return rule.pattern === sender.domain;
    case "org":
      return sender.domain === rule.pattern || sender.domain.endsWith(`.${rule.pattern}`);
  }
}

/**
 * Checks whether a sender's domain is a free-mail provider, where domain rules would cover strangers.
 *
 * @param {Pick<Sender, "domain" | "org">} sender - The sender's domains.
 * @returns {boolean} Whether its host or parent domain is in the free-mail list.
 */
export function isFreeMail(sender: Pick<Sender, "domain" | "org">): boolean {
  return FREE_MAIL_DOMAINS.has(sender.domain) || FREE_MAIL_DOMAINS.has(sender.org);
}

/**
 * Decides what happens to mail from a sender. The most specific rule kind with a match wins (address, then domain, then
 * org); within that kind, deny beats allow. A deny rejects; an allow is only `known` if DMARC passed, so a spoofed
 * allowlisted sender is still reviewed.
 *
 * @param {Sender | null} sender - The parsed sender, or `null` if the header From couldn't be read.
 * @param {readonly SenderRule[]} rules - The rules to check; ones that don't match the sender are ignored.
 * @returns {Decision} The verdict, the sender, and the rule that decided it.
 */
export function decide(sender: Sender | null, rules: readonly SenderRule[]): Decision {
  if (sender === null) {
    return { verdict: "unknown", sender, rule: null };
  }
  for (const kind of RULE_KINDS) {
    const matches = rules.filter((rule) => rule.kind === kind && ruleMatches(rule, sender));
    const rule = matches.find((match) => match.list === "deny") ?? matches[0];
    if (rule !== undefined) {
      if (rule.list === "deny") {
        return { verdict: "reject", sender, rule };
      }
      return { verdict: sender.dmarc === "pass" ? "known" : "unknown", sender, rule };
    }
  }
  return { verdict: "unknown", sender, rule: null };
}

export { CLOUDFLARE_AUTHSERV_ID, FREE_MAIL_DOMAINS, RULE_KINDS };
export type * from "./types/screener.ts";
