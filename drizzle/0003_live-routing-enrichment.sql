CREATE TABLE `routing_edge_enrichments` (
	`routing_graph_version` text NOT NULL,
	`edge_id` text NOT NULL,
	`osm_way_id` text,
	`travel_direction` text,
	`city_match_json` text NOT NULL,
	`city_json` text,
	`osm_json` text NOT NULL,
	`classification_json` text NOT NULL,
	PRIMARY KEY(`routing_graph_version`, `edge_id`),
	FOREIGN KEY (`routing_graph_version`) REFERENCES `routing_enrichment_manifests`(`routing_graph_version`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "routing_edge_enrichments_direction_check" CHECK("routing_edge_enrichments"."travel_direction" is null or "routing_edge_enrichments"."travel_direction" in ('forward', 'backward'))
);
--> statement-breakpoint
CREATE TABLE `routing_enrichment_manifests` (
	`routing_graph_version` text PRIMARY KEY NOT NULL,
	`manifest_json` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`loaded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
