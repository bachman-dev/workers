import {
  type APIInteraction,
  type APIInteractionResponsePong,
  InteractionResponseType,
  InteractionType,
} from "@bachman-dev/workers-shared/discord";
import { HTTPStatusCode } from "@bachman-dev/workers-shared/http";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { Env } from "../../types/cloudflare.ts";
import verifiedDiscordRequest from "../middleware/discord.ts";

const index = new Hono<{ Bindings: Env }>();

index.get("/", (ctx) => ctx.json({ success: true, message: "Point Discord to this URL for interactions" }));

index.post("/", verifiedDiscordRequest, async (ctx) => {
  const interaction = await ctx.req.json<APIInteraction>();
  switch (interaction.type) {
    case InteractionType.Ping:
      return ctx.json({ type: InteractionResponseType.Pong } satisfies APIInteractionResponsePong);
    default:
      throw new HTTPException(HTTPStatusCode.NotImplemented);
  }
});

export default index;
