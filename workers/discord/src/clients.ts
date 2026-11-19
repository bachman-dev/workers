import { APIVersion, REST } from "@bachman-dev/workers-shared/discord";

import type { Drizzle } from "./db/index.ts";

/** Looks up the bot clients and webhook tokens a batch needs, querying D1 at most once for each one that's found. */
export class DiscordClients {
  private readonly drizzle: Drizzle;
  private readonly bots = new Map<string, REST>();
  private readonly webhookTokens = new Map<string, string>();
  private webhookClient: REST | undefined;

  public constructor(drizzle: Drizzle) {
    this.drizzle = drizzle;
  }

  /**
   * Gets a REST client authenticated as a bot.
   *
   * @param {string} applicationId - The bot's application ID.
   * @returns {Promise<REST | undefined>} The client, or `undefined` if the `apps` table has no such bot.
   */
  public async bot(applicationId: string): Promise<REST | undefined> {
    let rest = this.bots.get(applicationId);
    if (rest === undefined) {
      const app = await this.drizzle.query.apps.findFirst({ where: { id: { eq: applicationId } } });
      if (app !== undefined) {
        rest = new REST({ version: APIVersion }).setToken(app.token);
        this.bots.set(applicationId, rest);
      }
    }
    return rest;
  }

  /**
   * Gets the REST client for webhook requests, which authenticate with the webhook token in the route instead.
   *
   * @returns {REST} The shared webhook client.
   */
  public webhook(): REST {
    this.webhookClient ??= new REST({ version: APIVersion });
    return this.webhookClient;
  }

  /**
   * Gets a webhook's token.
   *
   * @param {string} webhookId - The webhook's ID.
   * @returns {Promise<string | undefined>} The token, or `undefined` if the `webhooks` table has no such webhook.
   */
  public async webhookToken(webhookId: string): Promise<string | undefined> {
    let token = this.webhookTokens.get(webhookId);
    if (token === undefined) {
      const webhook = await this.drizzle.query.webhooks.findFirst({ where: { id: { eq: webhookId } } });
      if (webhook !== undefined) {
        ({ token } = webhook);
        this.webhookTokens.set(webhookId, token);
      }
    }
    return token;
  }
}

/** What every handler in a batch shares. */
export interface BatchContext {
  drizzle: Drizzle;
  clients: DiscordClients;
  /** Messages to send to the dead letter queue once the batch is done; each is acked when it's added. */
  rejectedMessages: unknown[];
}
