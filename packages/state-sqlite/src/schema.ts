import type { SignedSafeManifest } from "@traice/domain";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const lifecycleStates = [
  "observed",
  "encrypted",
  "manifest_pending",
  "committed",
  "failed",
] as const;

export type LifecycleState = (typeof lifecycleStates)[number];

export type SafeDetails = Readonly<Record<string, boolean | number | string>>;

export interface MultipartPart {
  readonly eTag: string;
  readonly partNumber: number;
}

export const operationalState = sqliteTable("operational_state", {
  key: text("key").primaryKey(),
  updatedAt: integer("updated_at").notNull(),
  value: text("value").notNull(),
});

export const safeAuditEvents = sqliteTable("safe_audit_events", {
  action: text("action").notNull(),
  createdAt: integer("created_at").notNull(),
  id: text("id").primaryKey(),
  safeDetails: text("safe_details", { mode: "json" }).$type<SafeDetails>().notNull(),
});

export const traceLifecycle = sqliteTable(
  "trace_lifecycle",
  {
    canonicalHash: text("canonical_hash"),
    captureRunId: text("capture_run_id"),
    capturedAt: text("captured_at").notNull(),
    ciphertextHash: text("ciphertext_hash"),
    clientManifestId: text("client_manifest_id"),
    client: text("client"),
    failureStage: text("failure_stage"),
    safeErrorCode: text("safe_error_code"),
    projectScopeId: text("project_scope_id"),
    provider: text("provider", { enum: ["anthropic", "openai"] }),
    state: text("state", { enum: lifecycleStates }).notNull(),
    traceId: text("trace_id").primaryKey(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("trace_lifecycle_project_scope_idx").on(table.projectScopeId, table.capturedAt),
    check(
      "trace_lifecycle_state_check",
      sql`${table.state} in ('observed', 'encrypted', 'manifest_pending', 'committed', 'failed')`
    ),
  ]
);

export const manifestOutbox = sqliteTable(
  "manifest_outbox",
  {
    attemptCount: integer("attempt_count").notNull().default(0),
    clientManifestId: text("client_manifest_id").primaryKey(),
    committedAt: integer("committed_at"),
    createdAt: integer("created_at").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    lastAttemptAt: integer("last_attempt_at"),
    safeErrorCode: text("safe_error_code"),
    signedManifest: text("signed_manifest_json", { mode: "json" })
      .$type<SignedSafeManifest>()
      .notNull(),
    traceId: text("trace_id")
      .notNull()
      .references(() => traceLifecycle.traceId),
  },
  (table) => [
    uniqueIndex("manifest_outbox_idempotency_idx").on(table.idempotencyKey),
    index("manifest_outbox_pending_idx").on(table.committedAt, table.createdAt),
  ]
);

export const safeEvents = sqliteTable(
  "safe_events",
  {
    createdAt: integer("created_at").notNull(),
    kind: text("kind").notNull(),
    safeDetails: text("safe_details", { mode: "json" }).$type<SafeDetails>().notNull(),
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  },
  (table) => [index("safe_events_created_idx").on(table.createdAt)]
);

export const deliveryObjects = sqliteTable(
  "delivery_objects",
  {
    ciphertextHash: text("ciphertext_hash").primaryKey(),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("delivery_objects_expiry_idx").on(table.deletedAt, table.expiresAt)]
);

export const manifestTombstones = sqliteTable("manifest_tombstones", {
  clientManifestId: text("client_manifest_id").primaryKey(),
  safeReasonCode: text("safe_reason_code").notNull(),
  tombstonedAt: integer("tombstoned_at").notNull(),
});

export const multipartUploads = sqliteTable("multipart_uploads", {
  ciphertextHash: text("ciphertext_hash").primaryKey(),
  parts: text("parts_json", { mode: "json" })
    .$type<readonly MultipartPart[]>()
    .notNull()
    .default(sql`'[]'`),
  updatedAt: integer("updated_at").notNull(),
  uploadId: text("upload_id").notNull(),
});

export const operationalSchema = {
  deliveryObjects,
  manifestOutbox,
  manifestTombstones,
  multipartUploads,
  operationalState,
  safeAuditEvents,
  safeEvents,
  traceLifecycle,
};
