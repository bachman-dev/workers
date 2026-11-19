import type { APIMessage } from "@bachman-dev/workers-shared/discord";
import { DefaultRestOptions } from "@discordjs/rest";

/** A request the worker sent to Discord's API. */
interface DiscordRequest {
  method: string;
  /** The route after `/api/v10`, e.g. `/channels/1/messages`. */
  path: string;
  query: URLSearchParams;
  body: unknown;
}

/** Answers a request, or returns `undefined` to fall through to the next responder. */
type DiscordResponder = (request: DiscordRequest) => Response | undefined;

const API_PREFIX = "/api/v10";
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const FIRST_MESSAGE_ID = 1000;
const MESSAGE_ROUTE =
  /^\/(?:channels\/(?<channelId>\d+)|webhooks\/(?<webhookId>\d+)\/[^\/]+)\/messages(?:\/(?<messageId>\d+))?$/v;
const WEBHOOK_ROUTE = /^\/webhooks\/(?<webhookId>\d+)\/[^\/]+$/v;

/** Every request sent to Discord since the last {@link resetDiscord}, in order. */
const requests: DiscordRequest[] = [];
const responders: DiscordResponder[] = [];
let nextMessageId = FIRST_MESSAGE_ID;

/**
 * Hands out the ID for the next message Discord "creates".
 *
 * @returns {string} A new message ID.
 */
function newMessageId(): string {
  nextMessageId += 1;
  return String(nextMessageId);
}

/**
 * Builds a JSON response like Discord's.
 *
 * @param {unknown} body - The response body.
 * @param {number} status - The HTTP status.
 * @returns {Response} The response.
 */
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Builds the message Discord would return for a post or edit.
 *
 * @param {string} channelId - The channel (or thread) the message is in.
 * @param {string} messageId - The message's ID.
 * @param {unknown} body - The request body that created or edited it.
 * @returns {Response} The message.
 */
function messageResponse(channelId: string, messageId: string, body: unknown): Response {
  const message: Partial<APIMessage> = {
    id: messageId,
    channel_id: channelId,
    ...(typeof body === "object" && body !== null ? body : {}),
  };
  return json(message);
}

/**
 * The default answers: posts and edits succeed and return a message, deletes return no content.
 *
 * @param {DiscordRequest} request - The request.
 * @returns {Response} Discord's answer.
 */
function defaultResponse(request: DiscordRequest): Response {
  const webhook = WEBHOOK_ROUTE.exec(request.path);
  if (request.method === "POST" && webhook !== null) {
    const channelId = request.query.get("thread_id") ?? "300";
    return request.query.get("wait") === "true"
      ? messageResponse(channelId, newMessageId(), request.body)
      : new Response(null, { status: HTTP_NO_CONTENT });
  }
  const route = MESSAGE_ROUTE.exec(request.path);
  if (route !== null) {
    const channelId = route.groups?.channelId ?? request.query.get("thread_id") ?? "300";
    const messageId = route.groups?.messageId;
    if (request.method === "POST" && messageId === undefined) {
      return messageResponse(channelId, newMessageId(), request.body);
    }
    if (request.method === "PATCH" && messageId !== undefined) {
      return messageResponse(channelId, messageId, request.body);
    }
    if (request.method === "DELETE" && messageId !== undefined) {
      return new Response(null, { status: HTTP_NO_CONTENT });
    }
  }
  return json({ message: `No mock for ${request.method} ${request.path}`, code: 0 }, HTTP_NOT_FOUND);
}

/**
 * Stands in for the REST client's `fetch`, answering Discord API requests and recording them.
 *
 * @param {string} url - The request URL.
 * @param {Parameters<typeof DefaultRestOptions.makeRequest>[1]} init - The request options.
 * @returns {Promise<Response>} The mocked answer.
 */
async function discordFetch(
  url: string,
  init: Parameters<typeof DefaultRestOptions.makeRequest>[1],
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.hostname !== "discord.com" || !parsed.pathname.startsWith(API_PREFIX)) {
    throw new Error(`Unexpected request in tests: ${init.method} ${url}`);
  }
  const request: DiscordRequest = {
    method: init.method ?? "GET",
    path: parsed.pathname.slice(API_PREFIX.length),
    query: parsed.searchParams,
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
  };
  requests.push(request);
  const custom = responders.map((responder) => responder(request)).find((response) => response !== undefined);
  return await Promise.resolve(custom ?? defaultResponse(request));
}

/**
 * Sends every Discord request from REST clients created after this call to the mock. The worker creates its clients for
 * each batch, so they all pick it up.
 */
function mockDiscord(): void {
  // The REST client's types expect undici's Response, but it reads the runtime's Response just the same
  Object.defineProperty(DefaultRestOptions, "makeRequest", { enumerable: true, value: discordFetch });
}

/** Forgets recorded requests and custom responders. */
function resetDiscord(): void {
  requests.length = 0;
  responders.length = 0;
}

/**
 * Answers matching requests with a custom response, ahead of the defaults.
 *
 * @param {string} method - The HTTP method to answer.
 * @param {() => Response} response - Builds the response.
 * @param {string} [path] - The route to answer, after `/api/v10`; every route if left out.
 */
function respondTo(method: string, response: () => Response, path?: string): void {
  responders.push((request) =>
    request.method === method && (path === undefined || request.path === path) ? response() : undefined,
  );
}

/**
 * Builds the error Discord returns for a message that no longer exists.
 *
 * @returns {Response} A 404 with error code 10008.
 */
function unknownMessage(): Response {
  return json({ message: "Unknown Message", code: 10_008 }, HTTP_NOT_FOUND);
}

/**
 * Builds the error Discord returns for a body it won't accept.
 *
 * @returns {Response} A 400 with error code 50035.
 */
function invalidFormBody(): Response {
  return json({ message: "Invalid Form Body", code: 50_035 }, HTTP_BAD_REQUEST);
}

export { invalidFormBody, mockDiscord, requests, resetDiscord, respondTo, unknownMessage };
