import type { MappedExportedHandler } from "@bachman-dev/workers-shared/cloudflare";

import fetch from "./fetch/index.ts";
import queue from "./queue/index.ts";
import type { Env, QueueBodyMap, QueueName } from "./types/cloudflare.ts";

export default {
  fetch,
  queue,
} satisfies MappedExportedHandler<QueueName, QueueBodyMap, Env>;
