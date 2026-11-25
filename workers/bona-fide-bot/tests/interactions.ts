import {
  type APIApplicationCommandInteractionDataBasicOption,
  type APIContainerComponent,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ComponentType,
  InteractionType,
} from "@bachman-dev/workers-shared/discord";
import type { RemoveSenderResult, ScreenerServiceRpc, StoredRule } from "@bachman-dev/workers-shared/screener";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";

import worker from "../src/index.ts";
import type { Env } from "../src/types/cloudflare.ts";

const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;
const MS_PER_SECOND = 1000;

const APP_ID = "100000000000000001";
const OWNER_ID = "300000000000000003";
const STRANGER_ID = "400000000000000004";
const GUILD_ID = "500000000000000005";
const CHANNEL_ID = "600000000000000006";
const MESSAGE_ID = "700000000000000007";
const INTERACTION_URL = "https://bot.example.com/interactions";

/** Who pressed a button or ran a command, and where. */
type Presser = { in: "guild"; userId: string } | { in: "dm"; userId: string };

/** A method call the fake Screener saw. */
interface ScreenerCall {
  method: keyof ScreenerServiceRpc;
  args: unknown[];
}

/** A stand-in for mail-screener's ScreenerService that records every call. */
interface FakeScreener {
  screener: ScreenerServiceRpc;
  calls: ScreenerCall[];
}

/** The keys a test signs interactions with; the public half stands in for DISCORD_PUBLIC_KEY. */
interface SigningKeys {
  privateKey: CryptoKey;
  publicKeyHex: string;
}

/** The test bindings, without SCREENER; tests that need it pass a fake. */
const { SCREENER: _screener, ...baseEnv } = env;

/**
 * Writes bytes as hex.
 *
 * @param {ArrayBuffer} bytes - The bytes.
 * @returns {string} Two lowercase hex digits per byte.
 */
function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, "0")).join(
    "",
  );
}

/**
 * Makes a fresh Ed25519 key pair, so no key is ever committed.
 *
 * @returns {Promise<SigningKeys>} The private key and the public key in hex.
 */
async function makeSigningKeys(): Promise<SigningKeys> {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in keys)) {
    throw new TypeError("Expected a key pair");
  }
  const publicKey = await crypto.subtle.exportKey("raw", keys.publicKey);
  if (!(publicKey instanceof ArrayBuffer)) {
    throw new TypeError("Expected raw key bytes");
  }
  return { privateKey: keys.privateKey, publicKeyHex: toHex(publicKey) };
}

/**
 * Builds a rule as the Screener would store it.
 *
 * @param {Partial<StoredRule>} overrides - Fields to set.
 * @returns {StoredRule} The rule.
 */
function storedRule(overrides: Partial<StoredRule> = {}): StoredRule {
  return {
    kind: "domain",
    pattern: "example.com",
    list: "allow",
    note: null,
    addedAt: 0,
    addedVia: "discord",
    ...overrides,
  };
}

/**
 * Makes a fake ScreenerService. Each method records its call, then answers with the override if there is one.
 *
 * @param {Partial<ScreenerServiceRpc>} overrides - Answers to give instead of the defaults.
 * @returns {FakeScreener} The fake and the calls it saw.
 */
function fakeScreener(overrides: Partial<ScreenerServiceRpc> = {}): FakeScreener {
  const calls: ScreenerCall[] = [];
  const screener: ScreenerServiceRpc = {
    decide: async (...args) => {
      calls.push({ method: "decide", args });
      return await (overrides.decide?.(...args) ?? Promise.resolve(null));
    },
    addSender: async (...args) => {
      calls.push({ method: "addSender", args });
      const [rule] = args;
      return await (overrides.addSender?.(...args) ??
        Promise.resolve({ ok: true, rule: storedRule({ ...rule, note: rule.note ?? null }) }));
    },
    removeSender: async (...args) => {
      calls.push({ method: "removeSender", args });
      const [kind, pattern] = args;
      const removed: RemoveSenderResult = { ok: true, rule: { kind, pattern } };
      return await (overrides.removeSender?.(...args) ?? Promise.resolve(removed));
    },
    listSenders: async (...args) => {
      calls.push({ method: "listSenders", args });
      return await (overrides.listSenders?.(...args) ?? Promise.resolve([]));
    },
  };
  return { screener, calls };
}

/**
 * Builds the bindings for one request: the test bindings, the test's public key, and optionally a fake Screener.
 *
 * @param {SigningKeys} keys - The keys the request is signed with.
 * @param {ScreenerServiceRpc | undefined} screener - The Screener, or `undefined` to leave it out as in previews.
 * @returns {Env} The bindings.
 */
function envWith(keys: SigningKeys, screener?: ScreenerServiceRpc): Env {
  const bindings: Env = { ...baseEnv, DISCORD_PUBLIC_KEY: keys.publicKeyHex };
  return screener === undefined ? bindings : { ...bindings, SCREENER: screener };
}

/**
 * Sends an interaction to the worker the way Discord does, signed with the test's private key.
 *
 * @param {unknown} interaction - The interaction body.
 * @param {Env} bindings - The bindings, from {@link envWith}.
 * @param {SigningKeys} keys - The keys to sign with.
 * @param {{ signature?: string | null }} options - A signature to send instead of a valid one, or `null` to send no
 *   signature headers at all.
 * @returns {Promise<Response>} The worker's response.
 */
async function sendInteraction(
  interaction: unknown,
  bindings: Env,
  keys: SigningKeys,
  options: { signature?: string | null } = {},
): Promise<Response> {
  const body = JSON.stringify(interaction);
  const timestamp = String(Math.floor(Date.now() / MS_PER_SECOND));
  const signature =
    options.signature === undefined
      ? toHex(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body)))
      : options.signature;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) {
    headers["x-signature-ed25519"] = signature;
    headers["x-signature-timestamp"] = timestamp;
  }
  const request = new Request<unknown, IncomingRequestCfProperties>(INTERACTION_URL, { method: "POST", headers, body });
  return await worker.fetch(request, bindings, createExecutionContext());
}

/**
 * Reads a JSON response body as an interaction response.
 *
 * @param {Response} response - The worker's response.
 * @returns {Promise<unknown>} The parsed body.
 */
async function responseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return body;
}

/**
 * Fills in the fields every interaction has.
 *
 * @param {Presser} presser - Who sent it, and where.
 * @returns {Record<string, unknown>} The common fields, plus `member` and `guild_id` in a server or `user` in a DM.
 */
function base(presser: Presser): Record<string, unknown> {
  const user = { id: presser.userId, username: "someone", discriminator: "0", global_name: null, avatar: null };
  const where =
    presser.in === "guild"
      ? {
          guild_id: GUILD_ID,
          member: {
            user,
            roles: [],
            joined_at: "2026-01-01T00:00:00.000Z",
            deaf: false,
            mute: false,
            permissions: "0",
          },
        }
      : { user };
  return {
    id: "800000000000000008",
    application_id: APP_ID,
    token: "interaction-token",
    version: 1,
    app_permissions: "0",
    locale: "en-US",
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 0,
    channel_id: CHANNEL_ID,
    channel: { id: CHANNEL_ID, type: 0 },
    ...where,
  };
}

/**
 * Builds a Ping, which Discord sends to check the endpoint.
 *
 * @returns {Record<string, unknown>} The interaction.
 */
function ping(): Record<string, unknown> {
  return {
    id: "800000000000000008",
    application_id: APP_ID,
    token: "interaction-token",
    version: 1,
    type: InteractionType.Ping,
  };
}

/**
 * Builds a button press on a message.
 *
 * @param {string} customId - The button's custom ID.
 * @param {Presser} presser - Who pressed it, and where.
 * @returns {Record<string, unknown>} The interaction, as Discord would send it.
 */
function buttonPress(customId: string, presser: Presser): Record<string, unknown> {
  return {
    ...base(presser),
    type: InteractionType.MessageComponent,
    data: { custom_id: customId, component_type: ComponentType.Button },
    message: { id: MESSAGE_ID, channel_id: CHANNEL_ID, components: [] },
  };
}

/**
 * Builds a run of `/screen <subcommand>`.
 *
 * @param {string} subcommand - The subcommand's name.
 * @param {APIApplicationCommandInteractionDataBasicOption[]} options - The options given.
 * @param {Presser} presser - Who ran it, and where.
 * @returns {Record<string, unknown>} The interaction, as Discord would send it.
 */
function screenCommand(
  subcommand: string,
  options: APIApplicationCommandInteractionDataBasicOption[],
  presser: Presser,
): Record<string, unknown> {
  return {
    ...base(presser),
    type: InteractionType.ApplicationCommand,
    data: {
      id: "900000000000000009",
      name: "screen",
      type: ApplicationCommandType.ChatInput,
      options: [{ type: ApplicationCommandOptionType.Subcommand, name: subcommand, options }],
    },
  };
}

/**
 * Builds a string option.
 *
 * @param {string} name - The option's name.
 * @param {string} value - Its value.
 * @returns {APIApplicationCommandInteractionDataBasicOption} The option.
 */
function stringOption(name: string, value: string): APIApplicationCommandInteractionDataBasicOption {
  return { type: ApplicationCommandOptionType.String, name, value };
}

/**
 * Builds a boolean option.
 *
 * @param {string} name - The option's name.
 * @param {boolean} value - Its value.
 * @returns {APIApplicationCommandInteractionDataBasicOption} The option.
 */
function booleanOption(name: string, value: boolean): APIApplicationCommandInteractionDataBasicOption {
  return { type: ApplicationCommandOptionType.Boolean, name, value };
}

/**
 * Builds a closed card like the one decide() returns.
 *
 * @param {string} content - The card's text.
 * @returns {APIContainerComponent} The card.
 */
function closedCard(content: string): APIContainerComponent {
  return { type: ComponentType.Container, components: [{ type: ComponentType.TextDisplay, content }] };
}

export {
  APP_ID,
  booleanOption,
  buttonPress,
  CHANNEL_ID,
  closedCard,
  envWith,
  fakeScreener,
  GUILD_ID,
  makeSigningKeys,
  MESSAGE_ID,
  OWNER_ID,
  ping,
  responseBody,
  screenCommand,
  sendInteraction,
  storedRule,
  STRANGER_ID,
  stringOption,
};
export type { FakeScreener, Presser, ScreenerCall, SigningKeys };
