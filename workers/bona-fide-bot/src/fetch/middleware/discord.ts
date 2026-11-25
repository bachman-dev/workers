import { verifyDiscordRequest } from "@bachman-dev/workers-shared/discord";
import { HTTPStatusCode } from "@bachman-dev/workers-shared/http";
import { log } from "@bachman-dev/workers-shared/util";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import type { Env } from "../../types/cloudflare.ts";

const verifiedDiscordRequest: MiddlewareHandler<{ Bindings: Env }> = async (ctx, next) => {
  const signatureHeader = ctx.req.header("x-signature-ed25519");
  const timestampHeader = ctx.req.header("x-signature-timestamp");
  const body = await ctx.req.text();
  if (typeof signatureHeader === "string" && typeof timestampHeader === "string") {
    let isValid = false;
    try {
      isValid = await verifyDiscordRequest(ctx.env.DISCORD_PUBLIC_KEY, signatureHeader, timestampHeader, body);
    } catch (error) {
      // A malformed signature, e.g. one of the wrong length, makes verification throw; it's just as unauthorized
      log("warn", "Couldn't verify an interaction's signature", error);
    }
    if (isValid) {
      await next();
      return;
    }
  }
  throw new HTTPException(HTTPStatusCode.Unauthorized);
};

export default verifiedDiscordRequest;
