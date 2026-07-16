ALTER TABLE `trace_lifecycle` ADD `capture_run_id` text;--> statement-breakpoint
ALTER TABLE `trace_lifecycle` ADD `client` text;--> statement-breakpoint
ALTER TABLE `trace_lifecycle` ADD `project_scope_id` text;--> statement-breakpoint
ALTER TABLE `trace_lifecycle` ADD `provider` text;--> statement-breakpoint
CREATE INDEX `trace_lifecycle_project_scope_idx` ON `trace_lifecycle` (`project_scope_id`,`captured_at`);