import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const apps = sqliteTable("apps", {
  id: text().primaryKey(),
  token: text().notNull(),
});

export const webhooks = sqliteTable("webhooks", {
  id: text().primaryKey(),
  token: text().notNull(),
});
