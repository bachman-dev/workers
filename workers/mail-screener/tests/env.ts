import { env } from "cloudflare:workers";

import type { Env } from "../src/types/cloudflare.ts";

/**
 * The test bindings, typed with the worker's own Env. The generated binding types import the worker without an
 * extension, which type-aware linting can't resolve.
 */
export const testEnv: Env = env;

/**
 * Gets the one Screener the worker uses.
 *
 * @returns {ReturnType<Env["SCREENER"]["get"]>} Its stub.
 */
export function screenerStub(): ReturnType<Env["SCREENER"]["get"]> {
  return testEnv.SCREENER.get(testEnv.SCREENER.idFromName("bachman.dev"));
}
