import { defineRelations } from "drizzle-orm";

import { apps, webhooks } from "./schema.ts";

const relations = defineRelations({ apps, webhooks }, () => {
  return {
    apps: {},
    webhooks: {},
  };
});

export default relations;
