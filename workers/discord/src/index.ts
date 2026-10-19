import type { MappedExportedHandler } from "@bachman-dev/workers-shared/cloudflare";
import { APIVersion, REST } from "@bachman-dev/workers-shared/discord";

import { getDrizzle } from "./db/index.ts";
import type { QueueBodyMap, QueueName } from "./types/cloudflare.ts";
import { executeWebhook, sendMessage } from "./util.ts";

export default {
  queue: async (batch, env): Promise<void> => {
    const restMap = new Map<string, REST>();
    const webhookTokenMap = new Map<string, string>();
    const drizzle = getDrizzle(env.DB);

    const rejectedMessages: unknown[] = [];

    for (const message of batch.messages) {
      switch (message.body.format) {
        case "message": {
          let rest = restMap.get(message.body.applicationId);
          if (typeof rest === "undefined") {
            // oxlint-disable-next-line no-await-in-loop -- Must be in order
            const app = await drizzle.query.apps.findFirst({
              where: {
                id: {
                  eq: message.body.applicationId,
                },
              },
            });
            if (typeof app !== "undefined") {
              rest = new REST({ version: APIVersion });
              rest.setToken(app.token);
              restMap.set(message.body.applicationId, rest);
            }
          }
          if (typeof rest === "undefined") {
            // Acked below since it's sent to the dead letter queue instead of being retried
            rejectedMessages.push({ error: "DISCORD_APP_ID_NOT_FOUND", message });
          } else {
            // oxlint-disable-next-line no-await-in-loop -- Must be in order
            await sendMessage(rest, message.body);
          }
          message.ack();
          break;
        }
        case "webhook": {
          let rest = restMap.get("webhook");
          if (typeof rest === "undefined") {
            rest = new REST({ version: APIVersion });
            restMap.set("webhook", rest);
          }
          let webhookToken = webhookTokenMap.get(message.body.webhookId);
          if (typeof webhookToken === "undefined") {
            // oxlint-disable-next-line no-await-in-loop -- Must be in order
            const webhook = await drizzle.query.webhooks.findFirst({
              where: {
                id: {
                  eq: message.body.webhookId,
                },
              },
            });
            if (typeof webhook !== "undefined") {
              webhookToken = webhook.token;
              webhookTokenMap.set(message.body.webhookId, webhook.token);
            }
          }
          if (typeof webhookToken === "undefined") {
            // Acked below since it's sent to the dead letter queue instead of being retried
            rejectedMessages.push({ error: "DISCORD_WEBHOOK_ID_NOT_FOUND", message });
          } else {
            // oxlint-disable-next-line no-await-in-loop -- Must be in order
            await executeWebhook(rest, message.body, webhookToken);
          }
          message.ack();
        }
      }
    }
    if (rejectedMessages.length > 0) {
      await env.DEAD_LETTER_QUEUE.sendBatch(
        rejectedMessages.map((message) => {
          return {
            body: message,
            contentType: "json",
          };
        }),
      );
    }
  },
} satisfies MappedExportedHandler<QueueName, QueueBodyMap, Env>;
