CREATE TABLE `anonymous_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_secret_hash` text NOT NULL,
	`user_agent_family` text,
	`first_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anonymous_installations_secret_hash_unique` ON `anonymous_installations` (`installation_secret_hash`);--> statement-breakpoint
CREATE INDEX `anonymous_installations_user_idx` ON `anonymous_installations` (`user_id`);--> statement-breakpoint
CREATE INDEX `anonymous_installations_last_seen_idx` ON `anonymous_installations` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`rotated_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_sessions_expiry_check" CHECK("auth_sessions"."expires_at" > "auth_sessions"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_refresh_token_hash_unique` ON `auth_sessions` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expires_idx` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `ride_points` (
	`id` text PRIMARY KEY NOT NULL,
	`ride_id` text NOT NULL,
	`upload_batch_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`accuracy_meters` real NOT NULL,
	`altitude_meters` real,
	`speed_meters_per_second` real,
	`heading_degrees` real,
	`quality` text NOT NULL,
	FOREIGN KEY (`upload_batch_id`,`ride_id`) REFERENCES `ride_upload_batches`(`id`,`ride_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ride_points_sequence_check" CHECK("ride_points"."sequence" >= 0),
	CONSTRAINT "ride_points_latitude_check" CHECK("ride_points"."latitude" between -90 and 90),
	CONSTRAINT "ride_points_longitude_check" CHECK("ride_points"."longitude" between -180 and 180),
	CONSTRAINT "ride_points_accuracy_check" CHECK("ride_points"."accuracy_meters" >= 0 and "ride_points"."accuracy_meters" <= 100),
	CONSTRAINT "ride_points_speed_check" CHECK("ride_points"."speed_meters_per_second" is null or "ride_points"."speed_meters_per_second" >= 0),
	CONSTRAINT "ride_points_heading_check" CHECK("ride_points"."heading_degrees" is null
        or ("ride_points"."heading_degrees" >= 0 and "ride_points"."heading_degrees" < 360)),
	CONSTRAINT "ride_points_quality_check" CHECK("ride_points"."quality" in ('good', 'fair', 'poor'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ride_points_ride_sequence_unique` ON `ride_points` (`ride_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `ride_points_batch_idx` ON `ride_points` (`upload_batch_id`);--> statement-breakpoint
CREATE INDEX `ride_points_ride_recorded_idx` ON `ride_points` (`ride_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `ride_upload_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`ride_id` text NOT NULL,
	`first_sequence` integer NOT NULL,
	`point_count` integer NOT NULL,
	`received_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`ride_id`) REFERENCES `rides`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ride_upload_batches_first_sequence_check" CHECK("ride_upload_batches"."first_sequence" >= 0),
	CONSTRAINT "ride_upload_batches_point_count_check" CHECK("ride_upload_batches"."point_count" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ride_upload_batches_id_ride_unique` ON `ride_upload_batches` (`id`,`ride_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ride_upload_batches_ride_sequence_unique` ON `ride_upload_batches` (`ride_id`,`first_sequence`);--> statement-breakpoint
CREATE INDEX `ride_upload_batches_ride_idx` ON `ride_upload_batches` (`ride_id`);--> statement-breakpoint
CREATE TABLE `rides` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'recording' NOT NULL,
	`title` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`distance_meters` real DEFAULT 0 NOT NULL,
	`accepted_point_count` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rides_status_check" CHECK("rides"."status" in ('recording', 'completed', 'abandoned')),
	CONSTRAINT "rides_status_timestamps_check" CHECK((
        ("rides"."status" = 'recording' and "rides"."ended_at" is null)
        or
        ("rides"."status" in ('completed', 'abandoned')
          and "rides"."ended_at" is not null)
      )),
	CONSTRAINT "rides_chronology_check" CHECK("rides"."ended_at" is null or "rides"."ended_at" >= "rides"."started_at"),
	CONSTRAINT "rides_distance_check" CHECK("rides"."distance_meters" >= 0),
	CONSTRAINT "rides_point_count_check" CHECK("rides"."accepted_point_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `rides_user_started_idx` ON `rides` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `rides_user_status_idx` ON `rides` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`account_type` text DEFAULT 'anonymous' NOT NULL,
	`email` text,
	`password_hash` text,
	`password_algorithm` text,
	`password_parameters` text,
	`display_name` text,
	`token_version` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`registered_at` integer,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "users_account_type_check" CHECK("users"."account_type" in ('anonymous', 'registered')),
	CONSTRAINT "users_registered_credentials_check" CHECK((
        ("users"."account_type" = 'anonymous'
          and "users"."email" is null
          and "users"."password_hash" is null
          and "users"."password_algorithm" is null
          and "users"."password_parameters" is null
          and "users"."registered_at" is null)
        or
        ("users"."account_type" = 'registered'
          and "users"."email" is not null
          and length("users"."email") > 0
          and "users"."password_hash" is not null
          and length("users"."password_hash") > 0
          and "users"."password_algorithm" is not null
          and length("users"."password_algorithm") > 0
          and "users"."password_parameters" is not null
          and "users"."registered_at" is not null)
      )),
	CONSTRAINT "users_email_normalized_check" CHECK("users"."email" is null
        or "users"."email" = lower(trim("users"."email"))),
	CONSTRAINT "users_token_version_check" CHECK("users"."token_version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_account_type_last_seen_idx` ON `users` (`account_type`,`last_seen_at`);