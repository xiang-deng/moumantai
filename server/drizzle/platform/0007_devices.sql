CREATE TABLE `devices` (
	`device_id` text PRIMARY KEY NOT NULL,
	`last_active_app` text DEFAULT 'home' NOT NULL,
	`last_active_face` text,
	`device_class` integer,
	`device_profile_width` integer,
	`device_profile_height` integer,
	`device_label` text,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL
);
