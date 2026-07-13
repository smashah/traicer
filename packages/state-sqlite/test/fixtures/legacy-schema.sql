CREATE TABLE IF NOT EXISTS operational_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS safe_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  safe_details TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trace_lifecycle (
  trace_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('observed', 'encrypted', 'manifest_pending', 'committed', 'failed')),
  canonical_hash TEXT,
  ciphertext_hash TEXT,
  client_manifest_id TEXT,
  failure_stage TEXT,
  safe_error_code TEXT,
  captured_at TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS manifest_outbox (
  client_manifest_id TEXT PRIMARY KEY NOT NULL,
  trace_id TEXT NOT NULL REFERENCES trace_lifecycle(trace_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  signed_manifest_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  safe_error_code TEXT,
  committed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS manifest_outbox_pending_idx
  ON manifest_outbox(committed_at, created_at);
CREATE TABLE IF NOT EXISTS safe_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  safe_details TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS safe_events_created_idx ON safe_events(created_at);
CREATE TABLE IF NOT EXISTS delivery_objects (
  ciphertext_hash TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS delivery_objects_expiry_idx
  ON delivery_objects(deleted_at, expires_at);
CREATE TABLE IF NOT EXISTS manifest_tombstones (
  client_manifest_id TEXT PRIMARY KEY NOT NULL,
  tombstoned_at INTEGER NOT NULL,
  safe_reason_code TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS multipart_uploads (
  ciphertext_hash TEXT PRIMARY KEY NOT NULL,
  upload_id TEXT NOT NULL,
  parts_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
