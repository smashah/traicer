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
