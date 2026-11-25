import {
  type APIInteraction,
  type APIInteractionResponsePong,
  InteractionResponseType,
  InteractionType,
  Utils,
} from "@bachman-dev/workers-shared/discord";
import { HTTPStatusCode } from "@bachman-dev/workers-shared/http";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { findCommand } from "../../commands/index.ts";
import type { Env } from "../../types/cloudflare.ts";
import handleScreenButton, { SCREEN_BUTTON_PREFIX } from "../interactions/screen-button.ts";
import verifiedDiscordRequest from "../middleware/discord.ts";

const index = new Hono<{ Bindings: Env }>();

index.get("/", (ctx) => ctx.json({ success: true, message: "Point Discord to this URL for interactions" }));

index.post("/", verifiedDiscordRequest, async (ctx) => {
  const interaction = await ctx.req.json<APIInteraction>();
  switch (interaction.type) {
    case InteractionType.Ping:
      return ctx.json({ type: InteractionResponseType.Pong } satisfies APIInteractionResponsePong);
    case InteractionType.ApplicationCommand: {
      const command = findCommand(interaction.data.name);
      if (command?.type === "chat" && Utils.isChatInputApplicationCommandInteraction(interaction)) {
        return ctx.json(await command.handleCommand(interaction, ctx.env));
      }
      throw new HTTPException(HTTPStatusCode.NotImplemented);
    }
    case InteractionType.MessageComponent:
      if (interaction.data.custom_id.startsWith(SCREEN_BUTTON_PREFIX)) {
        return ctx.json(await handleScreenButton(interaction, ctx.env));
      }
      throw new HTTPException(HTTPStatusCode.NotImplemented);
    default:
      throw new HTTPException(HTTPStatusCode.NotImplemented);
  }
});

export default index;
