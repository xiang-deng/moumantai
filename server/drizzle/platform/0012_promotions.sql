CREATE TABLE `promotions` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`app_id` text NOT NULL,
	`promoted_at` text NOT NULL,
	`summary` text,
	`msg_count` integer DEFAULT 0 NOT NULL
);
