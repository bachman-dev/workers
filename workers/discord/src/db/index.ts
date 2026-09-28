import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";

import relations from "./relations.ts";

export function getDrizzle(database: D1Database): DrizzleD1Database<typeof relations> {
  return drizzle(database, { relations });
}

export type Drizzle = DrizzleD1Database<typeof relations>;
