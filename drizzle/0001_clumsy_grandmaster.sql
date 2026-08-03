CREATE TABLE `auth_refresh_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`issued_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_refresh_tokens_session_idx` ON `auth_refresh_tokens` (`session_id`);--> statement-breakpoint
INSERT INTO `auth_refresh_tokens` (`token_hash`, `session_id`, `issued_at`)
SELECT `refresh_token_hash`, `id`, coalesce(`rotated_at`, `created_at`)
FROM `auth_sessions`;
