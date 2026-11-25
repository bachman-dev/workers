import {
  type APIApplicationCommandBasicOption,
  type APIApplicationCommandInteractionDataBasicOption,
  type APIChatInputApplicationCommandInteraction,
  type APIInteractionResponseChannelMessageWithSource,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type DiscordChatCommand,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "@bachman-dev/workers-shared/discord";
import {
  type AddSenderResult,
  type RemoveSenderResult,
  type RuleKey,
  type RuleKind,
  type RuleList,
  SCREENER_MAX_NOTE_LENGTH,
  type ScreenerServiceRpc,
  type StoredRule,
} from "@bachman-dev/workers-shared/screener";
import { log } from "@bachman-dev/workers-shared/util";

import { ephemeral, isOwner } from "../fetch/interactions/reply.ts";
import type { Env } from "../types/cloudflare.ts";

/** Discord's longest message. */
const MAX_MESSAGE_LENGTH = 2000;
/** The longest target Discord lets anyone type; an address can be at most 320 characters with an `org:` to spare. */
const MAX_TARGET_LENGTH = 330;
/** What a target starts with to name a parent domain and every subdomain under it. */
const ORG_PREFIX = "org:";

const LIST_LABELS: Readonly<Record<RuleList, string>> = { allow: "Allow", deny: "Deny" };
const LISTS: readonly RuleList[] = ["allow", "deny"];

/** The subcommands of /screen. */
type Subcommand = "allow" | "deny" | "remove" | "list";

/** The options a /screen subcommand was given. */
type Options = readonly APIApplicationCommandInteractionDataBasicOption[];

const TARGET_OPTION = {
  type: ApplicationCommandOptionType.String,
  name: "target",
  description: "An address, a domain for that exact host, or org:<domain> for a domain and its subdomains",
  required: true,
  max_length: MAX_TARGET_LENGTH,
} as const;

/**
 * Builds the options of /screen allow and /screen deny.
 *
 * @param {string} verb - What the rule does, for the descriptions.
 * @returns {APIApplicationCommandBasicOption[]} The target, note and seed options.
 */
function ruleOptions(verb: string): APIApplicationCommandBasicOption[] {
  return [
    TARGET_OPTION,
    {
      type: ApplicationCommandOptionType.String,
      name: "note",
      description: `Why you ${verb} this sender`,
      max_length: SCREENER_MAX_NOTE_LENGTH,
    },
    {
      type: ApplicationCommandOptionType.Boolean,
      name: "seed",
      description: "Mark the rule as part of the initial seed instead of added from Discord",
    },
  ];
}

const data: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  type: ApplicationCommandType.ChatInput,
  name: "screen",
  description: "Edit the mail screener's sender lists",
  // Only admins see it; the owner check is the real gate
  default_member_permissions: "0",
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "allow",
      description: "Let a sender's mail through",
      options: ruleOptions("allow"),
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "deny",
      description: "Reject a sender's mail",
      options: ruleOptions("deny"),
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "remove",
      description: "Remove a sender rule from whichever list it's on",
      options: [TARGET_OPTION],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "list",
      description: "List the sender rules",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "list",
          description: "Only this list",
          choices: [
            { name: "allow", value: "allow" },
            { name: "deny", value: "deny" },
          ],
        },
      ],
    },
  ],
};

/**
 * Shows text as inline code, which Discord never turns into links, mentions or formatting. Backticks become a lookalike
 * so the text can't close the code span early, as mail-screener's cards do.
 *
 * @param {string} text - The text, e.g. a pattern or note.
 * @returns {string} The text as inline code, or an em dash if it's empty.
 */
function code(text: string): string {
  const safe = text.replaceAll("`", "ˋ").replaceAll(/\s+/gv, " ").trim();
  return safe === "" ? "—" : `\`${safe}\``;
}

/**
 * Shows a rule's kind and pattern, e.g. `` `example.com` (domain) ``.
 *
 * @param {RuleKey} rule - The rule.
 * @returns {string} The rule as Markdown.
 */
function describeRule(rule: RuleKey): string {
  return `${code(rule.pattern)} (${rule.kind})`;
}

/**
 * Splits a target into a rule kind and pattern: `org:example.com` is an org rule, anything with an `@` is an address,
 * and anything else is a domain rule for that exact host. The Screener normalizes and validates the pattern.
 *
 * @param {string} target - The target as typed.
 * @returns {RuleKey} The kind and the pattern, not yet normalized.
 */
function parseTarget(target: string): RuleKey {
  const trimmed = target.trim();
  if (trimmed.toLowerCase().startsWith(ORG_PREFIX)) {
    return { kind: "org", pattern: trimmed.slice(ORG_PREFIX.length) };
  }
  const kind: RuleKind = trimmed.includes("@") ? "address" : "domain";
  return { kind, pattern: trimmed };
}

/**
 * Reads a string option.
 *
 * @param {Options} options - The subcommand's options.
 * @param {string} name - The option's name.
 * @returns {string | undefined} Its value, or `undefined` if it wasn't given.
 */
function stringOption(options: Options, name: string): string | undefined {
  const option = options.find((candidate) => candidate.name === name);
  return option?.type === ApplicationCommandOptionType.String ? option.value : undefined;
}

/**
 * Reads a boolean option.
 *
 * @param {Options} options - The subcommand's options.
 * @param {string} name - The option's name.
 * @returns {boolean} Its value, or `false` if it wasn't given.
 */
function booleanOption(options: Options, name: string): boolean {
  const option = options.find((candidate) => candidate.name === name);
  return option?.type === ApplicationCommandOptionType.Boolean && option.value;
}

/**
 * Finds which subcommand was run, and its options.
 *
 * @param {APIChatInputApplicationCommandInteraction} interaction - The command.
 * @returns {{ subcommand: Subcommand; options: Options } | null} The subcommand, or `null` if it isn't one of
 *   /screen's.
 */
function readSubcommand(
  interaction: APIChatInputApplicationCommandInteraction,
): { subcommand: Subcommand; options: Options } | null {
  const [option] = interaction.data.options ?? [];
  if (option?.type !== ApplicationCommandOptionType.Subcommand) {
    return null;
  }
  const subcommands: readonly Subcommand[] = ["allow", "deny", "remove", "list"];
  const subcommand = subcommands.find((name) => name === option.name);
  return subcommand === undefined ? null : { subcommand, options: option.options ?? [] };
}

/**
 * Says how adding a rule went.
 *
 * @param {RuleList} list - The list the rule was for.
 * @param {string} target - The target as typed.
 * @param {AddSenderResult} result - What the Screener said.
 * @returns {string} The reply.
 */
function addedText(list: RuleList, target: string, result: AddSenderResult): string {
  if (result.ok) {
    return `${list === "allow" ? "Allowed" : "Denied"} ${describeRule(result.rule)}`;
  }
  const shown = result.code === "free_mail" ? describeRule(result.rule) : code(target);
  return `Couldn't ${list} ${shown}: ${result.reason}`;
}

/**
 * Says how removing a rule went.
 *
 * @param {string} target - The target as typed.
 * @param {RemoveSenderResult} result - What the Screener said.
 * @returns {string} The reply.
 */
function removedText(target: string, result: RemoveSenderResult): string {
  if (result.ok) {
    return `Removed ${describeRule(result.rule)}`;
  }
  if (result.code === "not_found") {
    return `No rule for ${describeRule(result.rule)}`;
  }
  return `Couldn't remove ${code(target)}: ${result.reason}`;
}

/**
 * Lays out the sender rules in one message, grouped into allow and deny, one rule per line with its kind, pattern and
 * note. Rules that don't fit in Discord's 2000 characters are counted at the end instead.
 *
 * @param {readonly StoredRule[]} rules - The rules, most specific kind first.
 * @param {RuleList | undefined} only - The list the rules were filtered to, if any.
 * @returns {string} The message.
 */
function listText(rules: readonly StoredRule[], only: RuleList | undefined): string {
  if (rules.length === 0) {
    return only === undefined ? "No sender rules yet." : `No ${only} rules.`;
  }
  const lines: { text: string; isRule: boolean }[] = [];
  for (const list of only === undefined ? LISTS : [only]) {
    const listed = rules.filter((rule) => rule.list === list);
    lines.push({ text: `**${LIST_LABELS[list]}** (${listed.length})`, isRule: false });
    for (const rule of listed) {
      const note = rule.note === null ? "" : ` — ${code(rule.note)}`;
      lines.push({ text: `- ${rule.kind} ${code(rule.pattern)}${note}`, isRule: true });
    }
  }

  const footer = (more: number): string =>
    only === undefined ? `…and ${more} more. Use \`list:\` to show one list.` : `…and ${more} more.`;
  // How many rule lines there are from each line to the end
  const rulesFrom = lines.map((_line, index) => lines.slice(index).filter((line) => line.isRule).length);
  const kept: string[] = [];
  let length = 0;
  for (const [index, line] of lines.entries()) {
    const withLine = length + (kept.length > 0 ? 1 : 0) + line.text.length;
    // Leave room for the footer whenever rules are still to come
    const after = rulesFrom[index + 1] ?? 0;
    const reserve = after > 0 ? 1 + footer(after).length : 0;
    if (withLine + reserve > MAX_MESSAGE_LENGTH) {
      const more = rulesFrom[index] ?? 0;
      if (more > 0) {
        kept.push(footer(more));
      }
      break;
    }
    kept.push(line.text);
    length = withLine;
  }
  return kept.join("\n");
}

/**
 * Runs a /screen subcommand against the Screener.
 *
 * @param {ScreenerServiceRpc} screener - Mail-screener's ScreenerService.
 * @param {Subcommand} subcommand - The subcommand.
 * @param {Options} options - Its options.
 * @returns {Promise<string>} The reply.
 */
async function runSubcommand(screener: ScreenerServiceRpc, subcommand: Subcommand, options: Options): Promise<string> {
  if (subcommand === "list") {
    const list = stringOption(options, "list");
    const only = LISTS.find((known) => known === list);
    const rules = await (only === undefined ? screener.listSenders() : screener.listSenders(only));
    return listText(rules, only);
  }

  const target = stringOption(options, "target");
  if (target === undefined) {
    return "Unknown command.";
  }
  const rule = parseTarget(target);
  if (subcommand === "remove") {
    return removedText(target, await screener.removeSender(rule.kind, rule.pattern));
  }

  const note = stringOption(options, "note");
  if (note !== undefined && note.length > SCREENER_MAX_NOTE_LENGTH) {
    return `Notes can be at most ${SCREENER_MAX_NOTE_LENGTH} characters.`;
  }
  const result = await screener.addSender({
    ...rule,
    list: subcommand,
    note: note ?? null,
    addedVia: booleanOption(options, "seed") ? "seed" : "discord",
  });
  return addedText(subcommand, target, result);
}

/**
 * Answers /screen. Only the owner may run it; every reply is ephemeral and pings no one.
 *
 * @param {APIChatInputApplicationCommandInteraction} interaction - The command.
 * @param {Env} env - The worker's bindings.
 * @returns {Promise<APIInteractionResponseChannelMessageWithSource>} The reply.
 */
async function handleCommand(
  interaction: APIChatInputApplicationCommandInteraction,
  env: Env,
): Promise<APIInteractionResponseChannelMessageWithSource> {
  if (!isOwner(interaction, env)) {
    return ephemeral("This isn't yours to change.");
  }
  const run = readSubcommand(interaction);
  if (run === null) {
    return ephemeral("Unknown command.");
  }
  if (env.SCREENER === undefined) {
    return ephemeral("The screener isn't available here.");
  }
  try {
    return ephemeral(await runSubcommand(env.SCREENER, run.subcommand, run.options));
  } catch (error) {
    log("error", `Couldn't run /screen ${run.subcommand}`, error);
    return ephemeral("Couldn't reach the screener. Try again in a moment.");
  }
}

const screen: DiscordChatCommand<Env> = {
  type: "chat",
  scope: "guild",
  data,
  handleAutocomplete: () => [],
  handleCommand,
  isEphemeral: true,
  isLongRunning: false,
};

export default screen;
