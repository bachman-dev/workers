import {
  ApplicationCommandType,
  type DiscordSyncCommandsQueueBody,
  type DiscordSyncedCommand,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "@bachman-dev/workers-shared/discord";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { hashCommands } from "../src/commands.ts";
import { getDrizzle } from "../src/db/index.ts";
import { commandGuilds, commandSyncs } from "../src/db/schema.ts";
import { runBatch, text } from "./batch.ts";
import { invalidFormBody, missingAccess, requests, respondTo } from "./discord.ts";

const APPLICATION_ID = "100";
const OTHER_APPLICATION_ID = "101";
const UNKNOWN_APPLICATION_ID = "999";
const WORKER = "example-bot";
const OTHER_WORKER = "other-bot";
const GUILD_A = "500";
const GUILD_B = "600";

vi.setConfig({ testTimeout: 10_000 });

/**
 * Builds a chat command.
 *
 * @param {string} name - The command's name.
 * @param {string} description - What it says it does.
 * @returns {RESTPostAPIApplicationCommandsJSONBody} The command.
 */
function chatCommand(name: string, description = `The ${name} command`): RESTPostAPIApplicationCommandsJSONBody {
  return { type: ApplicationCommandType.ChatInput, name, description };
}

/**
 * Builds a global command for a sync body.
 *
 * @param {string} name - The command's name.
 * @returns {DiscordSyncedCommand} The command.
 */
function global(name: string): DiscordSyncedCommand {
  return { scope: "global", data: chatCommand(name) };
}

/**
 * Builds a guild command for a sync body.
 *
 * @param {string} name - The command's name.
 * @param {string} description - What it says it does.
 * @returns {DiscordSyncedCommand} The command.
 */
function guild(name: string, description?: string): DiscordSyncedCommand {
  return { scope: "guild", data: chatCommand(name, description) };
}

/**
 * Builds a sync body.
 *
 * @param {DiscordSyncedCommand[]} commands - Every command the worker has.
 * @param {Partial<DiscordSyncCommandsQueueBody>} overrides - Fields to set, e.g. `worker`.
 * @returns {DiscordSyncCommandsQueueBody} The queued body.
 */
function sync(
  commands: DiscordSyncedCommand[],
  overrides: Partial<DiscordSyncCommandsQueueBody> = {},
): DiscordSyncCommandsQueueBody {
  return { op: "sync-commands", applicationId: APPLICATION_ID, worker: WORKER, commands, ...overrides };
}

/**
 * Maps a guild command to a guild in `command_guilds`.
 *
 * @param {string} command - The command's name.
 * @param {string} guildId - The guild.
 * @param {string} worker - The worker whose command it is.
 * @returns {Promise<void>} Resolves once the row is in.
 */
async function mapCommand(command: string, guildId: string, worker = WORKER): Promise<void> {
  await getDrizzle(env.DB).insert(commandGuilds).values({ worker, command, guildId, createdAt: Date.now() });
}

/**
 * Removes a guild command's mapping to a guild.
 *
 * @param {string} command - The command's name.
 * @param {string} guildId - The guild.
 * @returns {Promise<void>} Resolves once the row is gone.
 */
async function unmapCommand(command: string, guildId: string): Promise<void> {
  await getDrizzle(env.DB)
    .delete(commandGuilds)
    .where(and(eq(commandGuilds.command, command), eq(commandGuilds.guildId, guildId)));
}

/**
 * Reads the `command_syncs` rows.
 *
 * @returns {Promise<{ applicationId: string; scope: string; worker: string; hash: string }[]>} The rows, by scope.
 */
async function syncRows(): Promise<{ applicationId: string; scope: string; worker: string; hash: string }[]> {
  const rows = await getDrizzle(env.DB).select().from(commandSyncs).orderBy(commandSyncs.scope);
  return rows.map(({ applicationId, scope, worker, hash }) => {
    return { applicationId, scope, worker, hash };
  });
}

/**
 * Lists the bulk overwrites sent to Discord.
 *
 * @returns {{ path: string; body: unknown }[]} Each PUT's route and body, in order.
 */
function overwrites(): { path: string; body: unknown }[] {
  return requests
    .filter((request) => request.method === "PUT")
    .map(({ path, body }) => {
      return { path, body };
    });
}

/**
 * Runs the first sync of the usual setup: a global /ping, /screen in guilds A and B, and /admin in guild B.
 *
 * @returns {Promise<DiscordSyncCommandsQueueBody>} The body that was synced.
 */
async function firstSync(): Promise<DiscordSyncCommandsQueueBody> {
  await mapCommand("screen", GUILD_A);
  await mapCommand("screen", GUILD_B);
  await mapCommand("admin", GUILD_B);
  const body = sync([global("ping"), guild("screen"), guild("admin")]);
  await runBatch([body]);
  requests.length = 0;
  return body;
}

describe("sync-commands", () => {
  it("bulk overwrites the global scope and each mapped guild on a first sync", async () => {
    expect.hasAssertions();
    await mapCommand("screen", GUILD_A);
    await mapCommand("screen", GUILD_B);
    await mapCommand("admin", GUILD_B);

    const { ids, result } = await runBatch([sync([guild("screen"), global("ping"), guild("admin")])]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(overwrites()).toStrictEqual([
      { path: `/applications/${APPLICATION_ID}/commands`, body: [chatCommand("ping")] },
      { path: `/applications/${APPLICATION_ID}/guilds/${GUILD_A}/commands`, body: [chatCommand("screen")] },
      {
        path: `/applications/${APPLICATION_ID}/guilds/${GUILD_B}/commands`,
        body: [chatCommand("admin"), chatCommand("screen")],
      },
    ]);
    await expect(syncRows()).resolves.toStrictEqual([
      {
        applicationId: APPLICATION_ID,
        scope: GUILD_A,
        worker: WORKER,
        hash: await hashCommands([chatCommand("screen")]),
      },
      {
        applicationId: APPLICATION_ID,
        scope: GUILD_B,
        worker: WORKER,
        hash: await hashCommands([chatCommand("admin"), chatCommand("screen")]),
      },
      {
        applicationId: APPLICATION_ID,
        scope: "global",
        worker: WORKER,
        hash: await hashCommands([chatCommand("ping")]),
      },
    ]);
  });

  it("makes no Discord calls when nothing changed", async () => {
    expect.hasAssertions();
    const body = await firstSync();
    const before = await syncRows();

    // The same commands in another order hash the same
    const { ids, result } = await runBatch([{ ...body, commands: body.commands.toReversed() }]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests).toStrictEqual([]);
    await expect(syncRows()).resolves.toStrictEqual(before);
  });

  it("overwrites only the guilds that have a changed guild command", async () => {
    expect.hasAssertions();
    await firstSync();

    await runBatch([sync([global("ping"), guild("screen"), guild("admin", "Changed")])]);

    expect(overwrites()).toStrictEqual([
      {
        path: `/applications/${APPLICATION_ID}/guilds/${GUILD_B}/commands`,
        body: [chatCommand("admin", "Changed"), chatCommand("screen")],
      },
    ]);
  });

  it("clears a guild that no longer gets any commands and deletes its row", async () => {
    expect.hasAssertions();
    const body = await firstSync();
    await unmapCommand("screen", GUILD_A);

    await runBatch([body]);

    expect(overwrites()).toStrictEqual([
      { path: `/applications/${APPLICATION_ID}/guilds/${GUILD_A}/commands`, body: [] },
    ]);
    await expect(syncRows()).resolves.toMatchObject([{ scope: GUILD_B }, { scope: "global" }]);
  });

  it("clears the global scope once the worker has no global commands", async () => {
    expect.hasAssertions();
    await firstSync();

    await runBatch([sync([guild("screen"), guild("admin")])]);

    expect(overwrites()).toStrictEqual([{ path: `/applications/${APPLICATION_ID}/commands`, body: [] }]);
    await expect(syncRows()).resolves.toMatchObject([{ scope: GUILD_A }, { scope: GUILD_B }]);
  });

  it("leaves scopes it never synced alone when there's nothing to send", async () => {
    expect.hasAssertions();

    // /screen isn't mapped to any guild, and there are no global commands
    const { ids, result } = await runBatch([sync([guild("screen")])]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests).toStrictEqual([]);
    await expect(syncRows()).resolves.toStrictEqual([]);
  });

  it("ignores mappings to global commands and to commands the worker doesn't have", async () => {
    expect.hasAssertions();
    await mapCommand("ping", GUILD_A);
    await mapCommand("gone", GUILD_A);
    await mapCommand("screen", GUILD_B);
    // Another worker's mapping is never this worker's
    await mapCommand("screen", GUILD_A, OTHER_WORKER);

    await runBatch([sync([global("ping"), guild("screen")])]);

    expect(overwrites()).toStrictEqual([
      { path: `/applications/${APPLICATION_ID}/commands`, body: [chatCommand("ping")] },
      { path: `/applications/${APPLICATION_ID}/guilds/${GUILD_B}/commands`, body: [chatCommand("screen")] },
    ]);
  });

  it("dead-letters a second worker's sync for the same application", async () => {
    expect.hasAssertions();
    await firstSync();
    const before = await syncRows();
    const deadLetters = vi.spyOn(env.DEAD_LETTER_QUEUE, "sendBatch");

    const { ids, result } = await runBatch([sync([global("other")], { worker: OTHER_WORKER })]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests).toStrictEqual([]);
    expect(deadLetters.mock.calls[0]?.[0]).toMatchObject([
      { body: { error: "DISCORD_COMMANDS_OWNED_BY_ANOTHER_WORKER" }, contentType: "json" },
    ]);
    await expect(syncRows()).resolves.toStrictEqual(before);
  });

  it("dead-letters a sync for an unknown application", async () => {
    expect.hasAssertions();
    const deadLetters = vi.spyOn(env.DEAD_LETTER_QUEUE, "sendBatch");

    const { ids, result } = await runBatch([sync([global("ping")], { applicationId: UNKNOWN_APPLICATION_ID })]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(requests).toStrictEqual([]);
    expect(deadLetters.mock.calls[0]?.[0]).toMatchObject([
      { body: { error: "DISCORD_APP_ID_NOT_FOUND" }, contentType: "json" },
    ]);
  });

  it("syncs the other scopes when the bot can't reach one guild", async () => {
    expect.hasAssertions();
    await mapCommand("screen", GUILD_A);
    await mapCommand("screen", GUILD_B);
    respondTo("PUT", missingAccess, `/applications/${APPLICATION_ID}/guilds/${GUILD_A}/commands`);

    const { ids, result } = await runBatch([sync([global("ping"), guild("screen")])]);

    expect(result.explicitAcks).toStrictEqual(ids);
    expect(result.retryMessages).toStrictEqual([]);
    expect(overwrites().map(({ path }) => path)).toStrictEqual([
      `/applications/${APPLICATION_ID}/commands`,
      `/applications/${APPLICATION_ID}/guilds/${GUILD_A}/commands`,
      `/applications/${APPLICATION_ID}/guilds/${GUILD_B}/commands`,
    ]);
    await expect(syncRows()).resolves.toMatchObject([{ scope: GUILD_B }, { scope: "global" }]);
  });

  it("leaves a guild's row as it was when the bot can't reach it to clear it", async () => {
    expect.hasAssertions();
    const body = await firstSync();
    const before = await syncRows();
    await unmapCommand("screen", GUILD_A);
    respondTo("PUT", missingAccess, `/applications/${APPLICATION_ID}/guilds/${GUILD_A}/commands`);

    await runBatch([body]);

    await expect(syncRows()).resolves.toStrictEqual(before);
  });

  it("retries only the body whose sync failed for another reason", async () => {
    expect.hasAssertions();
    await env.DB.prepare("INSERT INTO apps (id, token) VALUES (?, 'other-bot-token')").bind(OTHER_APPLICATION_ID).run();
    respondTo("PUT", invalidFormBody, `/applications/${APPLICATION_ID}/commands`);

    const { ids, result } = await runBatch([
      sync([global("ping")]),
      sync([global("ping")], { applicationId: OTHER_APPLICATION_ID, worker: OTHER_WORKER }),
    ]);

    expect(result.retryMessages).toStrictEqual([{ msgId: ids[0] }]);
    expect(result.explicitAcks).toStrictEqual([ids[1]]);
    await expect(syncRows()).resolves.toMatchObject([{ applicationId: OTHER_APPLICATION_ID, scope: "global" }]);
  });

  it("runs after the batch's posts", async () => {
    expect.hasAssertions();

    const { ids, result } = await runBatch([
      sync([global("ping")]),
      { format: "message", applicationId: APPLICATION_ID, channelId: "300", component: text("post") },
    ]);

    expect(result.explicitAcks.toSorted()).toStrictEqual(ids.toSorted());
    expect(requests.map(({ method }) => method)).toStrictEqual(["POST", "PUT"]);
  });
});
