import { defineRelations } from "drizzle-orm";

import { apps, messageRefs, webhooks } from "./schema.ts";

const relations = defineRelations({ apps, messageRefs, webhooks }, () => {
  return {
    apps: {},
    messageRefs: {},
    webhooks: {},
  };
});

export default relations;
