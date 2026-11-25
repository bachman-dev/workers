CREATE TABLE `command_guilds` (
	`worker` text NOT NULL,
	`command` text NOT NULL,
	`guild_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `command_guilds_pk` PRIMARY KEY(`worker`, `command`, `guild_id`)
);
--> statement-breakpoint
CREATE TABLE `command_syncs` (
	`application_id` text NOT NULL,
	`scope` text NOT NULL,
	`worker` text NOT NULL,
	`hash` text NOT NULL,
	`synced_at` integer NOT NULL,
	CONSTRAINT `command_syncs_pk` PRIMARY KEY(`application_id`, `scope`)
);
