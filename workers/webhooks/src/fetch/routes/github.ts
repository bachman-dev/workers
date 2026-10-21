import { HTTPStatusCode } from "@bachman-dev/workers-shared/http";
import { log } from "@bachman-dev/workers-shared/util";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { NOT_IMPLEMENTED, githubEventComponent } from "../../discord/event.ts";
import type { Env } from "../../types/cloudflare.ts";
import { isGithubWebhookEvent } from "../../types/github.ts";
import { validGithubWebhookHeaders, verifiedGithubWebhook } from "../middleware/github.ts";

const github = new Hono<{ Bindings: Env }>();

github.get("/", (ctx) => ctx.json({ success: true, message: "Point GitHub to this URL for webhooks" }));

github.post("/", validGithubWebhookHeaders, verifiedGithubWebhook, async (ctx) => {
  const { deliveryId, event } = ctx.req.valid("header");
  // The raw body stream was already consumed by signature verification; read Hono's cached copy instead
  const webhook = { event, payload: await ctx.req.json<unknown>() };
  // Always true, since the headers were validated; it narrows the payload to the X-GitHub-Event header's event
  if (!isGithubWebhookEvent(webhook)) {
    throw new HTTPException(HTTPStatusCode.BadRequest);
  }
  const existingDelivery = await ctx.env.GITHUB_BUCKET.head(`${deliveryId}.json`);
  if (!existingDelivery) {
    await ctx.env.GITHUB_BUCKET.put(`${deliveryId}.json`, JSON.stringify(webhook));
  }

  let component: ReturnType<typeof githubEventComponent>;
  try {
    component = githubEventComponent(webhook, { mentionId: ctx.env.DISCORD_MENTION_ID });
  } catch (error) {
    // GitHub doesn't retry failed deliveries, so dead-letter the delivery for a replay from R2 rather than fail it
    log("error", error);
    component = undefined;
    await ctx.env.DEAD_LETTER_QUEUE.send(
      { error: "GH_WEBHOOK_MESSAGE_FAILED", deliveryId, event, reason: String(error) },
      { contentType: "json" },
    );
  }
  // Actions we don't post, e.g. an issue being labeled, have no component and are acknowledged without a message
  if (component === NOT_IMPLEMENTED) {
    await ctx.env.DEAD_LETTER_QUEUE.send(
      { error: "GH_WEBHOOK_EVENT_NOT_IMPLEMENTED", deliveryId, event },
      { contentType: "json" },
    );
  } else if (component !== undefined) {
    await ctx.env.DISCORD_QUEUE.send({
      format: "webhook",
      webhookId: ctx.env.GITHUB_WEBHOOK_ID,
      component,
      // GitHub text can contain @everyone or Discord mention syntax, so only ever ping the configured user
      allowedMentions: { parse: [], users: [ctx.env.DISCORD_MENTION_ID] },
    });
  }
  return ctx.json({ success: true, deliveryId, duplicate: existingDelivery !== null }, HTTPStatusCode.Accepted);
});

export default github;
