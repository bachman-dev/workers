import type { MappedQueueHandler } from "@bachman-dev/workers-shared/cloudflare";

import type { Env, QueueBodyMap, QueueName } from "../types/cloudflare.ts";
import handleGithubWebhooks from "./handlers/github.ts";

const queue: MappedQueueHandler<QueueName, QueueBodyMap, Env> = async (batch, env, executionContext) => {
  switch (batch.queue) {
    case "github-webhook-queue":
      await handleGithubWebhooks(batch.messages, env, executionContext);
      break;
    default:
      await env.DEAD_LETTER_QUEUE.sendBatch(batch.messages);
      batch.ackAll();
  }
};

export default queue;
