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

    for (const { body } of batch.messages) {
      switch (body.format) {
        case "message": {
          let rest = restMap.get(body.applicationId);
          if (typeof rest === "undefined") {
            // oxlint-disable-next-line no-await-in-loop -- Must be in order
            const app = await drizzle.query.apps.findFirst({
              where: {
                id: {
                  eq: body.applicationId,
                },
              },
            });
            if (typeof app === "undefined") {
              throw new TypeError(`Unexpected application ID ${body.applicationId}`);
            }
            rest = new REST({ version: APIVersion });
            rest.setToken(app.token);
            restMap.set(body.applicationId, rest);
          }
          // oxlint-disable-next-line no-await-in-loop -- Must be in order
          await sendMessage(rest, body);
          break;
        }
        case "webhook": {
          let rest = restMap.get("webhook");
          if (typeof rest === "undefined") {
            rest = new REST({ version: APIVersion });
            restMap.set("webhook", rest);
          }
          let webhookToken = webhookTokenMap.get(body.webhookId);
          if (typeof webhookToken === "undefined") {
            // oxlint-disable-next-line no-await-in-loop -- Must be in order
            const webhook = await drizzle.query.webhooks.findFirst({
              where: {
                id: {
                  eq: body.webhookId,
                },
              },
            });
            if (typeof webhook === "undefined") {
              throw new TypeError(`Unexpected Webhook ID ${body.webhookId}`);
            }
            webhookToken = webhook.token;
            webhookTokenMap.set(body.webhookId, webhook.token);
          }
          // oxlint-disable-next-line no-await-in-loop -- Must be in order
          await executeWebhook(rest, body, webhookToken);
        }
      }
    }
  },
} satisfies MappedExportedHandler<QueueName, QueueBodyMap, Env>;
