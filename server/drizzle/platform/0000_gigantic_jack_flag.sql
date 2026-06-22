CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`sdk_bound_at` text,
	`archived_at` text,
	`last_active_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_scope_active_unique` ON `conversations` (`scope`) WHERE "conversations"."archived_at" IS NULL;--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`turn_mode` text,
	`source` text,
	`tool_calls_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_seq_unique` ON `messages` (`conversation_id`,`seq`);