ALTER TABLE `conversations` ADD `kind` text DEFAULT 'chat' NOT NULL;
--> statement-breakpoint
ALTER TABLE `conversations` ADD `draft_id` text;
--> statement-breakpoint
DROP INDEX `conversations_scope_active_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_scope_kind_active_unique` ON `conversations` (`scope`,`kind`) WHERE "conversations"."archived_at" IS NULL;
