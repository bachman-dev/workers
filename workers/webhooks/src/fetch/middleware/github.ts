import { HTTPStatusCode } from "@bachman-dev/workers-shared/http";
import { stringToUInt8Array } from "@bachman-dev/workers-shared/util";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";

import type { Env } from "../../types/cloudflare.ts";
import { type GithubWebhookEventName, isGithubWebhookEventName } from "../../types/github.ts";

export const validGithubWebhookHeaders = validator("header", (value) => {
  const hookId = value["x-github-hook-id"];
  const event = value["x-github-event"];
  const deliveryId = value["x-github-delivery"];
  const signature = value["x-hub-signature-256"];
  const userAgent = value["user-agent"];
  if (
    typeof hookId === "string" &&
    isGithubWebhookEventName(event) &&
    typeof deliveryId === "string" &&
    typeof signature === "string" &&
    typeof userAgent === "string" &&
    userAgent.startsWith("GitHub-Hookshot/")
  ) {
    return {
      hookId,
      event,
      deliveryId,
      signature,
      userAgent,
    };
  }
  throw new HTTPException(HTTPStatusCode.BadRequest, {
    message: `User Agent: ${userAgent} - Event: ${event} - Hook ID: ${hookId} - Delivery ID: ${deliveryId} - Signature ${signature}`,
  });
});

export const verifiedGithubWebhook: MiddlewareHandler<
  { Bindings: Env },
  string,
  {
    in: {
      header: {
        hookId: string;
        event: GithubWebhookEventName;
        deliveryId: string;
        signature: string;
        userAgent: string;
      };
    };
    out: {
      header: {
        hookId: string;
        event: GithubWebhookEventName;
        deliveryId: string;
        signature: string;
        userAgent: string;
      };
    };
  }
> = async (ctx, next): Promise<void> => {
  const { signature } = ctx.req.valid("header");
  const [_sha256, signatureHex] = signature.split("=");
  if (typeof signatureHex === "string") {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(ctx.env.GITHUB_WEBHOOK_SECRET),
      { name: "HMAC", hash: { name: "SHA-256" } },
      false,
      ["sign", "verify"],
    );
    const payload = await ctx.req.text();
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      stringToUInt8Array(signatureHex, "hex"),
      encoder.encode(payload),
    );
    if (verified) {
      await next();
    }
  }
  throw new HTTPException(HTTPStatusCode.Unauthorized);
};
