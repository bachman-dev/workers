import {
  ActivityType,
  type GatewayActivityUpdateData,
  type GatewayPresenceUpdateData,
  PresenceUpdateStatus,
} from "@bachman-dev/workers-shared/discord";

import type { ShownActivities } from "./types.ts";

/** Shown as "Playing …", "Listening to …", "Watching …" or "Competing in …". */
interface NamedActivity {
  type: ActivityType.Competing | ActivityType.Listening | ActivityType.Playing | ActivityType.Watching;
  name: string;
}

/** Shown as "Streaming …"; Discord only accepts `https://twitch.tv/` and `https://youtube.com/` URLs. */
interface StreamingActivity {
  type: ActivityType.Streaming;
  name: string;
  url: string;
}

/** Shown as the text alone, like a user's custom status. */
interface CustomActivity {
  type: ActivityType.Custom;
  state: string;
}

/** The fields bots may set for each activity type. */
type BotActivity = CustomActivity | NamedActivity | StreamingActivity;

interface ActivityPick {
  activity: BotActivity;
  key: string;
  startsCycle: boolean;
}

/** Discord requires a name on every activity, but doesn't display it for custom statuses. */
const CUSTOM_STATUS_NAME = "Custom Status";

/**
 * The pool activities are drawn from when the bot identifies and at the top of each hour. Every quip is shown once
 * before any repeats.
 */
const ACTIVITIES: readonly [BotActivity, ...BotActivity[]] = [
  // Star Trek: The Next Generation
  { state: "Tea. Earl Grey. Hot.", type: ActivityType.Custom },
  { name: "Data attempt a joke", type: ActivityType.Watching },
  { name: "the Ressikan flute", type: ActivityType.Listening },
  { name: "poker with the senior staff", type: ActivityType.Playing },
  { name: "Parrises Squares", type: ActivityType.Competing },

  // The Wheel of Time
  { state: "The Wheel weaves as the Wheel wills", type: ActivityType.Custom },
  { name: "Nynaeve tug her braid", type: ActivityType.Watching },
  { name: "dice with Mat Cauthon", type: ActivityType.Playing },
  { name: "a gleeman's tale", type: ActivityType.Listening },

  // Team Fortress 2
  { state: "A Spy is sappin' my status!", type: ActivityType.Custom },
  { name: "2Fort. Again.", type: ActivityType.Playing },
  { name: "the Soldier explain Sun Tzu", type: ActivityType.Listening },
  { name: "a hat-trading summit", type: ActivityType.Competing },

  // Gundam
  { state: "The Red Comet is three times faster than this bot", type: ActivityType.Custom },
  { name: "the skies for a red Zaku", type: ActivityType.Watching },
  { name: "with Gunpla", type: ActivityType.Playing },

  // Zenless Zone Zero
  { state: "Proxy online. Hollows: avoided.", type: ActivityType.Custom },
  { name: "a Hollow from a safe distance", type: ActivityType.Watching },
  { name: "the Random Play shelves", type: ActivityType.Listening },
  { name: "with a Bangboo", type: ActivityType.Playing },
];

function toActivityUpdate(activity: BotActivity): GatewayActivityUpdateData {
  switch (activity.type) {
    case ActivityType.Custom:
      return { name: CUSTOM_STATUS_NAME, state: activity.state, type: activity.type };
    case ActivityType.Streaming:
      return { name: activity.name, type: activity.type, url: activity.url };
    default:
      return { name: activity.name, type: activity.type };
  }
}

/**
 * Identifies an activity by its type and text, so the shown set survives edits to the list.
 *
 * @param {BotActivity} activity - The activity.
 * @returns {string} A key that is stable across deploys.
 */
function activityKey(activity: BotActivity): string {
  return `${activity.type}:${activity.type === ActivityType.Custom ? activity.state : activity.name}`;
}

/**
 * Picks a random activity that hasn't been shown this cycle. Once all have been shown, a new cycle starts with any
 * activity but the current one, so the cycle boundary never repeats a quip back to back either.
 *
 * @param {ShownActivities} history - The activities shown so far this cycle.
 * @returns {ActivityPick} The chosen activity, its key, and whether it starts a new cycle.
 */
function pickActivity(history: ShownActivities): ActivityPick {
  const unshown = ACTIVITIES.filter((activity) => !history.shown.has(activityKey(activity)));
  const startsCycle = unshown.length === 0;
  const pool = startsCycle ? ACTIVITIES.filter((activity) => activityKey(activity) !== history.current) : unshown;
  const activity = pool[Math.floor(Math.random() * pool.length)] ?? ACTIVITIES[0];
  return { activity, key: activityKey(activity), startsCycle };
}

/**
 * Builds an online presence showing one activity.
 *
 * @param {BotActivity} activity - The activity to show.
 * @returns {GatewayPresenceUpdateData} The presence to send in Identify or a Presence Update.
 */
function toPresence(activity: BotActivity): GatewayPresenceUpdateData {
  return {
    activities: [toActivityUpdate(activity)],
    afk: false,
    since: null,
    status: PresenceUpdateStatus.Online,
  };
}

export { type BotActivity, pickActivity, toPresence };
