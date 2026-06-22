ALTER TABLE `devices` ADD `paired` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `devices` ADD `paired_at` text;
--> statement-breakpoint
UPDATE `devices` SET `paired` = 1, `paired_at` = `created_at`;
