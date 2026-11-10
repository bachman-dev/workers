import type { GatewayDispatchPayload } from "@bachman-dev/workers-shared/discord";
import { log } from "@bachman-dev/workers-shared/util";

import type { DispatchContext } from "./types.ts";

/**
 * Logs a dispatch event with its shard and sequence number.
 *
 * @param {DispatchContext} context - The shard the event arrived on.
 * @param {GatewayDispatchPayload} payload - The dispatch payload.
 * @param {unknown} data - What to log as the event's data; defaults to the whole `d` field.
 */
export default function logDispatch(
  context: DispatchContext,
  payload: GatewayDispatchPayload,
  data: unknown = payload.d,
): void {
  log("info", `[shard ${context.shardId}] ${payload.t} (seq ${payload.s})`, data);
}
