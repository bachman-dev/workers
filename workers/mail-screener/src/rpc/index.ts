import type { APIContainerComponent } from "@bachman-dev/workers-shared/discord";
import { WorkerEntrypoint } from "cloudflare:workers";

import { SCREENED_DOMAIN } from "../durable/screener/constants.ts";
import type { Env } from "../types/cloudflare.ts";
import type { ReviewAction } from "../types/screener.ts";

/**
 * What other workers call over a service binding. bona-fide-bot binds it to answer review buttons, with `{ "binding":
 * "SCREENER", "service": "mail-screener", "entrypoint": "ScreenerService" }`.
 */
export default class ScreenerService extends WorkerEntrypoint<Env> {
  /**
   * Decides a review, as its card's buttons do.
   *
   * @param {string} reviewId - The review's ID, from the button's custom ID.
   * @param {ReviewAction} action - The action, from the button's custom ID.
   * @returns {Promise<APIContainerComponent | null>} The closed card to update the message with, or `null` if there's
   *   no such review.
   */
  public async decide(reviewId: string, action: ReviewAction): Promise<APIContainerComponent | null> {
    return await this.env.SCREENER.getByName(SCREENED_DOMAIN).decide(reviewId, action);
  }
}
