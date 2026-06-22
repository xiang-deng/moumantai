ALTER TABLE `conversations` ADD `sdk_backend` text;
--> statement-breakpoint
UPDATE `conversations` SET `sdk_backend` = 'claude' WHERE `sdk_session_id` IS NOT NULL AND `sdk_backend` IS NULL;
