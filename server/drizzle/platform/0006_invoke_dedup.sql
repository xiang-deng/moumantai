CREATE TABLE `invoke_dedup` (
	`conversation_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`result_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoke_dedup_conv_req_unique` ON `invoke_dedup` (`conversation_id`,`client_request_id`);
--> statement-breakpoint
CREATE INDEX `invoke_dedup_created_at_idx` ON `invoke_dedup` (`created_at`);
