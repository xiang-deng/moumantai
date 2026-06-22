CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
