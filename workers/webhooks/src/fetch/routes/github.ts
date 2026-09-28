import { HTTPStatusCode } from "@bachman-dev/workers-shared/http";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { Env } from "../../types/cloudflare.ts";
import { validGithubWebhookHeaders, verifiedGithubWebhook } from "../middleware/github.ts";

const github = new Hono<{ Bindings: Env }>();

github.post("/", validGithubWebhookHeaders, verifiedGithubWebhook, async (ctx) => {
  const { deliveryId } = ctx.req.valid("header");
  const payload = ctx.req.raw.body;
  const existingDelivery = await ctx.env.GITHUB_BUCKET.head(`${deliveryId}.json`);
  if (payload) {
    if (!existingDelivery) {
      await ctx.env.GITHUB_BUCKET.put(`${deliveryId}.json`, payload);
    }
    await ctx.env.GITHUB_QUEUE.send({ deliveryId });
    return ctx.json({ success: true, deliveryId, duplicate: existingDelivery !== null }, HTTPStatusCode.Accepted);
  }
  throw new HTTPException(HTTPStatusCode.UnprocessableEntity);
});

export default github;
