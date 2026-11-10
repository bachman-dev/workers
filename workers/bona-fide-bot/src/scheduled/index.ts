import { log } from "@bachman-dev/workers-shared/util";

import { getGatewayBot, shardName } from "../durable/gateway/api.ts";
import type { EnsureResult } from "../durable/gateway/types.ts";
import type { Env } from "../types/cloudflare.ts";

/*
 * Keeps one Gateway Durable Object running per shard Discord recommends. Each shard's own alarm keeps it connected;
 * this starts shards after a deploy, restarts any that stopped, and follows changes to the recommended shard count.
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = async (_controller, env) => {
  const gateway = await getGatewayBot(env.DISCORD_APP_SECRET);
  const shardCount = gateway.shards;
  const maxConcurrency = gateway.session_start_limit.max_concurrency;

  const results: EnsureResult[] = await Promise.all(
    Array.from(
      { length: shardCount },
      async (_value, shardId) =>
        await env.GATEWAY.getByName(shardName(shardId)).ensure({ maxConcurrency, shardCount, shardId }),
    ),
  );

  // Shard 0 always exists, so it reports how many shards ran before; stop any beyond the new count.
  const previousShardCount = results[0]?.previousShardCount ?? null;
  if (previousShardCount !== null && previousShardCount > shardCount) {
    await Promise.all(
      Array.from(
        { length: previousShardCount - shardCount },
        async (_value, index) => await env.GATEWAY.getByName(shardName(shardCount + index)).stop(),
      ),
    );
  }

  log("info", "Gateway shards reconciled", {
    halted: results.filter((result) => !result.running).length,
    maxConcurrency,
    previousShardCount,
    sessionStartsRemaining: gateway.session_start_limit.remaining,
    shardCount,
  });
};

export default scheduled;
