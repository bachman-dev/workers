import { HTTPStatusCode } from "@bachman-dev/workers-shared/http";
import { log } from "@bachman-dev/workers-shared/util";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { Env } from "../types/cloudflare.ts";
import index from "./routes/index.ts";

const fetch: ExportedHandlerFetchHandler<Env> = async (request, env, executionContext) => {
  const app = new Hono<{ Bindings: Env }>().basePath(env.BASE_PATH);
  app.route("/", index);
  app.notFound((ctx) => ctx.body(null, HTTPStatusCode.NotFound));
  app.onError((exception, ctx) => {
    log("error", exception);
    if (exception instanceof HTTPException) {
      return ctx.json({ success: false, error: exception.message }, exception.status);
    }
    return ctx.json({ success: false, error: "Internal Server Error" }, HTTPStatusCode.InternalServerError);
  });

  return await app.fetch(request, env, executionContext);
};

export default fetch;
