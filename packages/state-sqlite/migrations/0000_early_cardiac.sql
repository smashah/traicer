CREATE TABLE IF NOT EXISTS `delivery_objects` (
	`ciphertext_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `delivery_objects_expiry_idx` ON `delivery_objects` (`deleted_at`,`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `manifest_outbox` (
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`client_manifest_id` text PRIMARY KEY NOT NULL,
	`committed_at` integer,
	`created_at` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`last_attempt_at` integer,
	`safe_error_code` text,
	`signed_manifest_json` text NOT NULL,
	`trace_id` text NOT NULL,
	FOREIGN KEY (`trace_id`) REFERENCES `trace_lifecycle`(`trace_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `manifest_outbox_idempotency_idx` ON `manifest_outbox` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `manifest_outbox_pending_idx` ON `manifest_outbox` (`committed_at`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `manifest_tombstones` (
	`client_manifest_id` text PRIMARY KEY NOT NULL,
	`safe_reason_code` text NOT NULL,
	`tombstoned_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `multipart_uploads` (
	`ciphertext_hash` text PRIMARY KEY NOT NULL,
	`parts_json` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	`upload_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `operational_state` (
	`key` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `safe_audit_events` (
	`action` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`safe_details` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `safe_events` (
	`created_at` integer NOT NULL,
	`kind` text NOT NULL,
	`safe_details` text NOT NULL,
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `safe_events_created_idx` ON `safe_events` (`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `trace_lifecycle` (
	`canonical_hash` text,
	`captured_at` text NOT NULL,
	`ciphertext_hash` text,
	`client_manifest_id` text,
	`failure_stage` text,
	`safe_error_code` text,
	`state` text NOT NULL,
	`trace_id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "trace_lifecycle_state_check" CHECK("trace_lifecycle"."state" in ('observed', 'encrypted', 'manifest_pending', 'committed', 'failed'))
);
