import { DurableObject } from "cloudflare:workers";

import type { Env } from "./types/cloudflare.ts";

/** Holds the sender rules and open reviews for one screened domain. */
export default class Screener extends DurableObject<Env> {
  /**
   * Answers a liveness check by reading from the object's SQLite storage.
   *
   * @returns {string} Always `"ok"`.
   */
  public ping(): string {
    return this.ctx.storage.sql.exec<{ ok: string }>("SELECT 'ok' AS ok").one().ok;
  }
}
