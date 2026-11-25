import { defineRelations } from "drizzle-orm";

import { apps, commandGuilds, commandSyncs, messageRefs, webhooks } from "./schema.ts";

const relations = defineRelations({ apps, commandGuilds, commandSyncs, messageRefs, webhooks }, () => {
  return {
    apps: {},
    commandGuilds: {},
    commandSyncs: {},
    messageRefs: {},
    webhooks: {},
  };
});

export default relations;
