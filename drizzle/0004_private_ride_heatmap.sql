CREATE TABLE `ride_heat_cells` (
	`user_id` text NOT NULL,
	`resolution` integer NOT NULL,
	`cell_id` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`ride_count` integer NOT NULL,
	`distance_meters` real NOT NULL,
	`updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
	PRIMARY KEY(`user_id`, `resolution`, `cell_id`, `bucket_start`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ride_heat_cells_resolution_check" CHECK("ride_heat_cells"."resolution" in (5, 6, 7)),
	CONSTRAINT "ride_heat_cells_count_check" CHECK("ride_heat_cells"."ride_count" > 0),
	CONSTRAINT "ride_heat_cells_distance_check" CHECK("ride_heat_cells"."distance_meters" >= 0),
	CONSTRAINT "ride_heat_cells_latitude_check" CHECK("ride_heat_cells"."latitude" between -90 and 90),
	CONSTRAINT "ride_heat_cells_longitude_check" CHECK("ride_heat_cells"."longitude" between -180 and 180)
);
--> statement-breakpoint
CREATE INDEX `ride_heat_cells_owner_viewport_idx` ON `ride_heat_cells` (`user_id`,`resolution`,`bucket_start`,`latitude`,`longitude`);
--> statement-breakpoint
CREATE TABLE `ride_heat_cell_contributions` (
	`ride_id` text NOT NULL,
	`user_id` text NOT NULL,
	`resolution` integer NOT NULL,
	`cell_id` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`distance_meters` real NOT NULL,
	PRIMARY KEY(`ride_id`, `resolution`, `cell_id`, `bucket_start`),
	FOREIGN KEY (`ride_id`) REFERENCES `rides`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ride_heat_contributions_resolution_check" CHECK("ride_heat_cell_contributions"."resolution" in (5, 6, 7)),
	CONSTRAINT "ride_heat_contributions_distance_check" CHECK("ride_heat_cell_contributions"."distance_meters" > 0)
);
--> statement-breakpoint
CREATE INDEX `ride_heat_contributions_owner_idx` ON `ride_heat_cell_contributions` (`user_id`);
--> statement-breakpoint
CREATE TRIGGER `ride_heat_contribution_insert`
AFTER INSERT ON `ride_heat_cell_contributions`
BEGIN
	INSERT INTO `ride_heat_cells` (
		`user_id`, `resolution`, `cell_id`, `bucket_start`, `latitude`, `longitude`, `ride_count`, `distance_meters`, `updated_at`
	) VALUES (
		NEW.`user_id`, NEW.`resolution`, NEW.`cell_id`, NEW.`bucket_start`, NEW.`latitude`, NEW.`longitude`, 1, NEW.`distance_meters`, unixepoch() * 1000
	)
	ON CONFLICT(`user_id`, `resolution`, `cell_id`, `bucket_start`) DO UPDATE SET
		`ride_count` = `ride_count` + 1,
		`distance_meters` = `distance_meters` + NEW.`distance_meters`,
		`updated_at` = unixepoch() * 1000;
END;
--> statement-breakpoint
CREATE TRIGGER `ride_heat_contribution_delete`
AFTER DELETE ON `ride_heat_cell_contributions`
BEGIN
	DELETE FROM `ride_heat_cells`
	WHERE `user_id` = OLD.`user_id`
		AND `resolution` = OLD.`resolution`
		AND `cell_id` = OLD.`cell_id`
		AND `bucket_start` = OLD.`bucket_start`
		AND `ride_count` = 1;
	UPDATE `ride_heat_cells`
	SET `ride_count` = `ride_count` - 1,
		`distance_meters` = `distance_meters` - OLD.`distance_meters`,
		`updated_at` = unixepoch() * 1000
	WHERE `user_id` = OLD.`user_id`
		AND `resolution` = OLD.`resolution`
		AND `cell_id` = OLD.`cell_id`
		AND `bucket_start` = OLD.`bucket_start`;
END;
