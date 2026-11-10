import { verifyDiscordRequest } from "@bachman-dev/workers-shared/discord";
import { HTTPStatusCode } from "@bachman-dev/workers-shared/http";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import type { Env } from "../../types/cloudflare.ts";

const verifiedDiscordRequest: MiddlewareHandler<{ Bindings: Env }> = async (ctx, next) => {
  const signatureHeader = ctx.req.header("x-signature-ed25519");
  const timestampHeader = ctx.req.header("x-signature-timestamp");
  const body = await ctx.req.text();
  if (typeof signatureHeader === "string" && typeof timestampHeader === "string") {
    const isValid = await verifyDiscordRequest(ctx.env.DISCORD_PUBLIC_KEY, signatureHeader, timestampHeader, body);
    if (isValid) {
      await next();
      return;
    }
  }
  throw new HTTPException(HTTPStatusCode.Unauthorized);
};

export default verifiedDiscordRequest;
