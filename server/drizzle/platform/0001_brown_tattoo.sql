ALTER TABLE `messages` ADD `client_msg_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `status` text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `failure_reason` text;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_client_msg_id_unique` ON `messages` (`client_msg_id`) WHERE "messages"."client_msg_id" IS NOT NULL;