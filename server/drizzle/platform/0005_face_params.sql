CREATE TABLE `face_params` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`app_id` text NOT NULL,
	`face_id` text NOT NULL,
	`params` text NOT NULL,
	`params_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `face_params_conv_app_face_unique` ON `face_params` (`conversation_id`,`app_id`,`face_id`);