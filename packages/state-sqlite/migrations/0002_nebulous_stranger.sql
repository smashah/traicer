CREATE TABLE `session_labels` (
	`closed_at` integer,
	`labeler_version` text NOT NULL,
	`labels_json` text NOT NULL,
	`project_scope_id` text,
	`session_key` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_labels_scope_idx` ON `session_labels` (`project_scope_id`);--> statement-breakpoint
CREATE TABLE `trace_labels` (
	`labeler_version` text NOT NULL,
	`labels_json` text NOT NULL,
	`session_key` text NOT NULL,
	`trace_id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trace_labels_session_idx` ON `trace_labels` (`session_key`);