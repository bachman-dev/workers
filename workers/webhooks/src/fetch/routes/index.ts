import { HTTPStatusCode } from "@bachman-dev/workers-shared/http";
import { Hono } from "hono";

import type { Env } from "../../types/cloudflare.ts";
import github from "./github.ts";

const index = new Hono<{ Bindings: Env }>();

index.route("/github", github);

index.get("/", (ctx) => ctx.json({ success: true }, HTTPStatusCode.Ok));

export default index;
