import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const apps = sqliteTable("apps", {
  id: text().primaryKey(),
  token: text().notNull(),
});

export const webhooks = sqliteTable("webhooks", {
  id: text().primaryKey(),
  token: text().notNull(),
});

/** The Discord message posted for each queued ref, so later edits and deletes can find it. */
export const messageRefs = sqliteTable("message_refs", {
  ref: text("ref").primaryKey(),
  /** Whether the message was posted by a bot or by executing a webhook. */
  format: text("format", { enum: ["message", "webhook"] }).notNull(),
  /** The bot that posted the message; picks the token for edits and deletes. */
  applicationId: text("application_id"),
  /** The webhook that posted the message. */
  webhookId: text("webhook_id"),
  /** The thread a webhook posted the message into. */
  threadId: text("thread_id"),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  /** The version of the last post or edit applied to the message. */
  version: integer("version").notNull(),
  /** Unix time in milliseconds. */
  createdAt: integer("created_at").notNull(),
  /** Unix time in milliseconds. */
  updatedAt: integer("updated_at").notNull(),
  /** Unix time in milliseconds; null until the message is deleted. */
  deletedAt: integer("deleted_at"),
});

/** Which guilds each guild command is registered in; one row per command and guild. */
export const commandGuilds = sqliteTable(
  "command_guilds",
  {
    /** The worker whose command it is, as named in its sync-commands bodies. */
    worker: text("worker").notNull(),
    /** The command's name. */
    command: text("command").notNull(),
    guildId: text("guild_id").notNull(),
    /** Unix time in milliseconds. */
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.worker, table.command, table.guildId] })],
);

/** What was last sent to Discord for each scope of an application's commands, so unchanged scopes are skipped. */
export const commandSyncs = sqliteTable(
  "command_syncs",
  {
    applicationId: text("application_id").notNull(),
    /** `global`, or the ID of the guild the commands were sent to. */
    scope: text("scope").notNull(),
    /** The worker that owns this application's commands. */
    worker: text("worker").notNull(),
    /** The SHA-256 hash, in hex, of the exact command array last sent for this scope. */
    hash: text("hash").notNull(),
    /** Unix time in milliseconds. */
    syncedAt: integer("synced_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.applicationId, table.scope] })],
);
