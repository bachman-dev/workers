CREATE TABLE `apps` (
	`id` text PRIMARY KEY,
	`token` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY,
	`token` text NOT NULL
);
