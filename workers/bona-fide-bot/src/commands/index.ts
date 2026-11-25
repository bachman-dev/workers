import type { DiscordCommand } from "@bachman-dev/workers-shared/discord";

import type { Env } from "../types/cloudflare.ts";
import screen from "./screen.ts";

/**
 * Every command the bot has. The interactions route finds commands here by name, and the cron sends this same list to
 * the discord worker to sync with Discord, so this is the only place a command is defined.
 */
const COMMANDS: readonly DiscordCommand<Env>[] = [screen];

/**
 * Finds a command by name.
 *
 * @param {string} name - The command's name, from the interaction.
 * @returns {DiscordCommand<Env> | undefined} The command, or `undefined` if the bot has none by that name.
 */
function findCommand(name: string): DiscordCommand<Env> | undefined {
  return COMMANDS.find((command) => command.data.name === name);
}

export { COMMANDS, findCommand };
