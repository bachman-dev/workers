import {
  ActivityType,
  type GatewayPresenceUpdateData,
  PresenceUpdateStatus,
} from "@bachman-dev/workers-shared/discord";

import type { ShownActivities } from "./types.ts";

interface QuipPick {
  quip: string;
  key: string;
  startsCycle: boolean;
}

/** Discord requires a name on every activity, but doesn't display it for custom statuses. */
const CUSTOM_STATUS_NAME = "Custom Status";

/**
 * Quips shown as the bot's custom status, drawn when it identifies and at the top of each hour. Every quip is shown
 * once before any repeats.
 *
 * These are custom statuses rather than Playing/Watching/etc. activities because the member list drops those verbs and
 * shows only the name, so the verb is written into the text instead.
 */
const QUIPS: readonly [string, ...string[]] = [
  // Star Trek: The Next Generation
  "Tea. Earl Grey. Hot.",
  "Watching Data attempt a joke",
  "Listening to the Ressikan flute",
  "Playing poker with the senior staff",
  "Competing in Parrises Squares",

  // The Wheel of Time
  "The Wheel weaves as the Wheel wills",
  "Watching Nynaeve tug her braid",
  "Playing dice with Mat Cauthon",
  "Listening to a gleeman's tale",

  // Team Fortress 2
  "A Spy is sappin' my status!",
  "Playing 2Fort. Again.",
  "Listening to the Soldier explain Sun Tzu",
  "Competing in a hat-trading summit",

  // Gundam
  "The Red Comet is three times faster than this bot",
  "Watching the skies for a red Zaku",
  "Playing with Gunpla",

  // Zenless Zone Zero
  "Proxy online. Hollows: avoided.",
  "Watching a Hollow from a safe distance",
  "Listening to the Random Play shelves",
  "Playing with a Bangboo",
];

/**
 * Identifies a quip by its text, so the shown set survives edits to the list.
 *
 * @param {string} quip - The quip.
 * @returns {string} A key that is stable across deploys.
 */
function quipKey(quip: string): string {
  return `${ActivityType.Custom}:${quip}`;
}

/**
 * Picks a random quip that hasn't been shown this cycle. Once all have been shown, a new cycle starts with any quip but
 * the current one, so the cycle boundary never repeats a quip back to back either.
 *
 * @param {ShownActivities} history - The quips shown so far this cycle.
 * @returns {QuipPick} The chosen quip, its key, and whether it starts a new cycle.
 */
function pickQuip(history: ShownActivities): QuipPick {
  const unshown = QUIPS.filter((quip) => !history.shown.has(quipKey(quip)));
  const startsCycle = unshown.length === 0;
  const pool = startsCycle ? QUIPS.filter((quip) => quipKey(quip) !== history.current) : unshown;
  const quip = pool[Math.floor(Math.random() * pool.length)] ?? QUIPS[0];
  return { key: quipKey(quip), quip, startsCycle };
}

/**
 * Builds an online presence with a quip as the custom status.
 *
 * @param {string} quip - The text to show.
 * @returns {GatewayPresenceUpdateData} The presence to send in Identify or a Presence Update.
 */
function toPresence(quip: string): GatewayPresenceUpdateData {
  return {
    activities: [{ name: CUSTOM_STATUS_NAME, state: quip, type: ActivityType.Custom }],
    afk: false,
    since: null,
    status: PresenceUpdateStatus.Online,
  };
}

export { pickQuip, toPresence };
