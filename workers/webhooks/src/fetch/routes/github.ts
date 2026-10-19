import { HTTPStatusCode } from "@bachman-dev/workers-shared/http";
import { Hono } from "hono";

import type { Env } from "../../types/cloudflare.ts";
import type { GithubWebhookPayload } from "../../types/github.ts";
import { validGithubWebhookHeaders, verifiedGithubWebhook } from "../middleware/github.ts";

const github = new Hono<{ Bindings: Env }>();

github.get("/", (ctx) => ctx.json({ success: true, message: "Point GitHub to this URL for webhooks" }));

github.post("/", validGithubWebhookHeaders, verifiedGithubWebhook, async (ctx) => {
  const { deliveryId, event } = ctx.req.valid("header");
  // The raw body stream was already consumed by signature verification; read Hono's cached copy instead
  const payload = await ctx.req.json<GithubWebhookPayload>();
  const existingDelivery = await ctx.env.GITHUB_BUCKET.head(`${deliveryId}.json`);
  if (!existingDelivery) {
    await ctx.env.GITHUB_BUCKET.put(`${deliveryId}.json`, JSON.stringify({ event, payload }));
  }
  await ctx.env.GITHUB_QUEUE.send({ deliveryId });
  return ctx.json({ success: true, deliveryId, duplicate: existingDelivery !== null }, HTTPStatusCode.Accepted);
});

export default github;
