import {
  type DiscordSyncCommandsQueueBody,
  type REST,
  RESTJSONErrorCodes,
  type RESTPostAPIApplicationCommandsJSONBody,
  Routes,
} from "@bachman-dev/workers-shared/discord";
import { log } from "@bachman-dev/workers-shared/util";
import { and, eq } from "drizzle-orm";

import type { BatchContext } from "./clients.ts";
import type { Drizzle } from "./db/index.ts";
import { commandSyncs } from "./db/schema.ts";

/** The `command_syncs` scope of an application's global commands; every other scope is a guild ID. */
const GLOBAL_SCOPE = "global";
const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;

/** What one scope of an application's commands should hold after a sync. */
interface ScopePlan {
  /** `global`, or a guild ID. */
  scope: string;
  /** The commands to send, sorted by name; empty to clear the scope. */
  commands: RESTPostAPIApplicationCommandsJSONBody[];
  /** The hash of `commands`. */
  hash: string;
  /** The hash stored for this scope by the last sync, if there was one. */
  storedHash: string | undefined;
}

/** How each scope fared, for the log. */
interface SyncSummary {
  overwritten: string[];
  cleared: string[];
  unchanged: string[];
  missingAccess: string[];
}

/**
 * Sorts commands by name, so the same commands always hash the same however the worker listed them.
 *
 * @param {readonly RESTPostAPIApplicationCommandsJSONBody[]} commands - The commands.
 * @returns {RESTPostAPIApplicationCommandsJSONBody[]} A sorted copy.
 */
function sortByName(
  commands: readonly RESTPostAPIApplicationCommandsJSONBody[],
): RESTPostAPIApplicationCommandsJSONBody[] {
  return commands.toSorted((first, second) => {
    if (first.name === second.name) {
      return 0;
    }
    return first.name < second.name ? -1 : 1;
  });
}

/**
 * Hashes the exact command array that would be sent for a scope.
 *
 * @param {readonly RESTPostAPIApplicationCommandsJSONBody[]} commands - The commands, already sorted.
 * @returns {Promise<string>} The SHA-256 digest of the array's JSON, in hex.
 */
async function hashCommands(commands: readonly RESTPostAPIApplicationCommandsJSONBody[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(commands)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, "0")).join(
    "",
  );
}

/**
 * Checks whether a Discord REST error says the bot can't reach a guild, e.g. because it isn't in it.
 *
 * @param {unknown} error - The error thrown by the REST client.
 * @returns {boolean} True for Discord's Missing Access error.
 */
function isMissingAccessError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === RESTJSONErrorCodes.MissingAccess
  );
}

/**
 * Works out what each scope should hold: the global scope gets the worker's global commands, and each guild that
 * `command_guilds` maps one of its guild commands to gets those. Scopes synced before that get nothing now are cleared;
 * scopes never synced that get nothing are left alone, so a first sync never clears commands it didn't put there.
 *
 * @param {DiscordSyncCommandsQueueBody} body - The queued sync.
 * @param {Map<string, string>} storedHashes - The hash stored for each scope this application was synced to before.
 * @param {Drizzle} drizzle - The database.
 * @returns {Promise<ScopePlan[]>} The global scope first if it's in the plan, then each guild in ID order, each with
 *   the hash of its commands.
 */
async function planScopes(
  body: DiscordSyncCommandsQueueBody,
  storedHashes: Map<string, string>,
  drizzle: Drizzle,
): Promise<ScopePlan[]> {
  const globalCommands = body.commands.filter((command) => command.scope === "global").map(({ data }) => data);
  const guildCommands = body.commands.filter((command) => command.scope === "guild").map(({ data }) => data);
  const globalNames = new Set(globalCommands.map((command) => command.name));
  const guildNames = new Set(guildCommands.map((command) => command.name));

  // Which guild commands each guild gets, by name
  const namesByGuild = new Map<string, Set<string>>();
  const mappedNames = new Set<string>();
  const rows = await drizzle.query.commandGuilds.findMany({ where: { worker: { eq: body.worker } } });
  for (const row of rows) {
    if (guildNames.has(row.command)) {
      const names = namesByGuild.get(row.guildId) ?? new Set<string>();
      names.add(row.command);
      namesByGuild.set(row.guildId, names);
      mappedNames.add(row.command);
    } else if (globalNames.has(row.command)) {
      log("warn", `command_guilds maps ${body.worker}'s /${row.command} to guild ${row.guildId}, but it's global`);
    } else {
      log(
        "warn",
        `command_guilds maps /${row.command} to guild ${row.guildId}, but ${body.worker} has no such command`,
      );
    }
  }
  for (const name of guildNames) {
    if (!mappedNames.has(name)) {
      log("info", `${body.worker}'s guild command /${name} isn't mapped to any guild, so it's registered nowhere`);
    }
  }

  const plans = new Map<string, RESTPostAPIApplicationCommandsJSONBody[]>();
  if (globalCommands.length > 0) {
    plans.set(GLOBAL_SCOPE, sortByName(globalCommands));
  }
  for (const [guildId, names] of namesByGuild) {
    plans.set(guildId, sortByName(guildCommands.filter((command) => names.has(command.name))));
  }
  for (const scope of storedHashes.keys()) {
    if (!plans.has(scope)) {
      plans.set(scope, []);
    }
  }

  const planned = await Promise.all(
    [...plans.entries()].map(async ([scope, commands]): Promise<ScopePlan> => {
      return { scope, commands, hash: await hashCommands(commands), storedHash: storedHashes.get(scope) };
    }),
  );
  return planned.toSorted((first, second) => {
    if (first.scope === second.scope) {
      return 0;
    }
    if (first.scope === GLOBAL_SCOPE || second.scope === GLOBAL_SCOPE) {
      return first.scope === GLOBAL_SCOPE ? -1 : 1;
    }
    return first.scope < second.scope ? -1 : 1;
  });
}

/**
 * Bulk overwrites one scope's commands on Discord, then records the sync: an upserted row for a scope that has
 * commands, or no row for a scope that was cleared.
 *
 * @param {REST} rest - The REST client, authenticated as the bot.
 * @param {DiscordSyncCommandsQueueBody} body - The queued sync.
 * @param {ScopePlan} plan - The scope, what it should hold, and its hash.
 * @param {Drizzle} drizzle - The database.
 * @returns {Promise<void>} Resolves once Discord and D1 are both updated.
 */
async function overwriteScope(
  rest: REST,
  body: DiscordSyncCommandsQueueBody,
  plan: ScopePlan,
  drizzle: Drizzle,
): Promise<void> {
  const { applicationId, worker } = body;
  const { hash } = plan;
  const route =
    plan.scope === GLOBAL_SCOPE
      ? Routes.applicationCommands(applicationId)
      : Routes.applicationGuildCommands(applicationId, plan.scope);
  await rest.put(route, { body: plan.commands });

  const isScope = and(eq(commandSyncs.applicationId, applicationId), eq(commandSyncs.scope, plan.scope));
  if (plan.commands.length === 0) {
    await drizzle.delete(commandSyncs).where(isScope);
  } else {
    const syncedAt = Date.now();
    await drizzle
      .insert(commandSyncs)
      .values({ applicationId, scope: plan.scope, worker, hash, syncedAt })
      .onConflictDoUpdate({
        target: [commandSyncs.applicationId, commandSyncs.scope],
        set: { worker, hash, syncedAt },
      });
  }
}

/**
 * Syncs one worker's commands for an application. Throws if Discord or D1 fail, except for a guild the bot can't reach,
 * which is logged and skipped so one bad mapping doesn't retry forever.
 *
 * @param {Message<DiscordSyncCommandsQueueBody>} message - The queued sync.
 * @param {BatchContext} context - The batch's database, clients and rejected messages.
 * @returns {Promise<void>} Resolves once the message is acked or rejected.
 */
async function syncCommandsOrThrow(
  message: Message<DiscordSyncCommandsQueueBody>,
  context: BatchContext,
): Promise<void> {
  const { body } = message;
  const { clients, drizzle, rejectedMessages } = context;

  const rest = await clients.bot(body.applicationId);
  if (rest === undefined) {
    // Acked since it's sent to the dead letter queue instead of being retried
    rejectedMessages.push({ error: "DISCORD_APP_ID_NOT_FOUND", message });
    message.ack();
    return;
  }

  const synced = await drizzle.query.commandSyncs.findMany({ where: { applicationId: { eq: body.applicationId } } });
  const owners = [...new Set(synced.map((row) => row.worker))].filter((owner) => owner !== body.worker);
  if (owners.length > 0) {
    // Acked since it's sent to the dead letter queue instead of being retried
    rejectedMessages.push({
      error: "DISCORD_COMMANDS_OWNED_BY_ANOTHER_WORKER",
      reason: `${owners.join(", ")} already syncs application ${body.applicationId}'s commands, so ${body.worker} can't; two workers would overwrite each other's commands`,
      message,
    });
    message.ack();
    return;
  }

  const storedHashes = new Map(synced.map((row) => [row.scope, row.hash]));
  const summary: SyncSummary = { overwritten: [], cleared: [], unchanged: [], missingAccess: [] };
  for (const plan of await planScopes(body, storedHashes, drizzle)) {
    if (plan.hash === plan.storedHash) {
      summary.unchanged.push(plan.scope);
    } else {
      try {
        // oxlint-disable-next-line no-await-in-loop -- One scope at a time, so Discord's rate limits apply to one request
        await overwriteScope(rest, body, plan, drizzle);
        (plan.commands.length === 0 ? summary.cleared : summary.overwritten).push(plan.scope);
      } catch (error) {
        if (plan.scope === GLOBAL_SCOPE || !isMissingAccessError(error)) {
          throw error;
        }
        // The bot isn't in the guild; its row is left as it was, and the next sync tries again
        log("warn", `Can't sync ${body.worker}'s commands to guild ${plan.scope}: the bot has no access to it`);
        summary.missingAccess.push(plan.scope);
      }
    }
  }
  log("info", `Synced ${body.worker}'s commands for application ${body.applicationId}`, summary);
  message.ack();
}

/**
 * Syncs each queued worker's commands with Discord, one body at a time. Never throws: a failure retries that body only,
 * and the hash check means a retry skips the scopes that already went through.
 *
 * @param {readonly Message<DiscordSyncCommandsQueueBody>[]} messages - The batch's syncs, in delivery order.
 * @param {BatchContext} context - The batch's database, clients and rejected messages.
 * @returns {Promise<void>} Resolves once every message is acked, rejected, or set to retry.
 */
export default async function syncCommands(
  messages: readonly Message<DiscordSyncCommandsQueueBody>[],
  context: BatchContext,
): Promise<void> {
  for (const message of messages) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Must be in order
      await syncCommandsOrThrow(message, context);
    } catch (error) {
      log(
        "error",
        `Couldn't sync ${message.body.worker}'s commands for application ${message.body.applicationId}`,
        error,
      );
      message.retry();
    }
  }
}

export { hashCommands };
