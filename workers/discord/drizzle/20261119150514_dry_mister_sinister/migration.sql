CREATE TABLE `message_refs` (
	`ref` text PRIMARY KEY,
	`format` text NOT NULL,
	`application_id` text,
	`webhook_id` text,
	`thread_id` text,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
