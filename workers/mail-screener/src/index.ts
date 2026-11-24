import { log } from "@bachman-dev/workers-shared/util";

import { decide, parseSender } from "./decide.ts";
import { decodeHeaderText } from "./mime.ts";
import type { Env } from "./types/cloudflare.ts";
import type { Decision, Sender } from "./types/screener.ts";

/** How a forwarded message is tagged in its `X-Screener` header, for the inbox's filters. */
type ScreenerTag = "known" | "unknown" | "error";

/** The domain this worker screens. Forwarding to it would loop back here. */
const SCREENED_DOMAIN = "bachman.dev";

const REJECT_REASON = "Message rejected: the recipient doesn't accept mail from this sender";
const CANNOT_FORWARD_REASON = "Message rejected: it can't be forwarded to the recipient";

/**
 * Refuses a destination on the screened domain, which would send each message back through this worker.
 *
 * @param {string} destination - The `DESTINATION` secret.
 * @throws {Error} If the destination is on the screened domain or one of its subdomains.
 */
function assertNoLoop(destination: string): void {
  const domain = destination
    .slice(destination.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/v, "");
  if (domain === SCREENED_DOMAIN || domain.endsWith(`.${SCREENED_DOMAIN}`)) {
    log("error", `DESTINATION is on ${SCREENED_DOMAIN}, which would loop back to this worker; not forwarding`);
    throw new Error(`DESTINATION must not be an address on ${SCREENED_DOMAIN}`);
  }
}

/**
 * Gets the one Screener every message is checked against.
 *
 * @param {Env} env - The worker's bindings.
 * @returns {ReturnType<Env["SCREENER"]["get"]>} Its stub.
 */
function screener(env: Env): ReturnType<Env["SCREENER"]["get"]> {
  return env.SCREENER.get(env.SCREENER.idFromName(SCREENED_DOMAIN));
}

/**
 * Forwards a message to the destination, tagged for the inbox's filters. A failed forward is logged and rethrown, so it
 * shows as an error in Email Routing's activity log instead of vanishing.
 *
 * @param {ForwardableEmailMessage} message - The message.
 * @param {Env} env - The worker's bindings.
 * @param {ScreenerTag} tag - The `X-Screener` header's value.
 * @returns {Promise<void>} Resolves once the message is forwarded.
 */
async function forward(message: ForwardableEmailMessage, env: Env, tag: ScreenerTag): Promise<void> {
  try {
    await message.forward(env.DESTINATION, new Headers({ "X-Screener": tag }));
  } catch (error) {
    log("error", `Couldn't forward a message tagged ${tag}`, error);
    throw error;
  }
}

/**
 * Decides what happens to a message, without throwing.
 *
 * @param {ForwardableEmailMessage} message - The message.
 * @param {Env} env - The worker's bindings.
 * @returns {Promise<Decision | null>} The decision, or `null` if it couldn't be made.
 */
async function screen(message: ForwardableEmailMessage, env: Env): Promise<Decision | null> {
  try {
    const sender = parseSender(message.headers);
    // Without a readable From there's nothing to match; it's reviewed by hand in the Screener folder
    return sender === null ? decide(null, []) : await screener(env).match(sender);
  } catch (error) {
    log("error", "Couldn't screen a message; forwarding it tagged error", error);
    return null;
  }
}

/**
 * Opens or bumps the review for an unknown sender. Failures are logged and swallowed: the message was already
 * forwarded, and a missing card mustn't cost it.
 *
 * @param {ForwardableEmailMessage} message - The message.
 * @param {Env} env - The worker's bindings.
 * @param {Sender} sender - The sender.
 * @returns {Promise<void>} Resolves once the review is updated, or the failure is logged.
 */
async function review(message: ForwardableEmailMessage, env: Env, sender: Sender): Promise<void> {
  try {
    const subject = decodeHeaderText(message.headers.get("subject") ?? "");
    await screener(env).openReview(sender, subject);
  } catch (error) {
    log("error", "Couldn't open or update the review for an unknown sender", error);
  }
}

export { default as Screener } from "./screener.ts";

export default {
  email: async (message, env): Promise<void> => {
    assertNoLoop(env.DESTINATION);
    // Nothing holds a message that can't be forwarded, and forward() would fail, so bounce it instead of dropping it.
    // Only an explicit false counts: `wrangler dev`'s local message leaves the property out.
    // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- It's undefined under wrangler dev
    if (message.canBeForwarded === false) {
      log("warn", "Rejecting a message that can't be forwarded");
      message.setReject(CANNOT_FORWARD_REASON);
      return;
    }

    const decision = await screen(message, env);
    if (decision === null) {
      await forward(message, env, "error");
      return;
    }

    log("info", "Screened a message", { verdict: decision.verdict, sender: decision.sender?.address ?? null });
    switch (decision.verdict) {
      case "reject":
        message.setReject(REJECT_REASON);
        break;
      case "known":
        await forward(message, env, "known");
        break;
      case "unknown":
        await forward(message, env, "unknown");
        if (decision.sender !== null) {
          await review(message, env, decision.sender);
        }
        break;
    }
  },
} satisfies ExportedHandler<Env>;
