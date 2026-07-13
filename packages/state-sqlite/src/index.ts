import { Database } from "bun:sqlite";

const migrationZero = `
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
);`;

export const openOperationalState = (path: string) => {
  const database = new Database(path, { create: true, strict: true });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  database.exec(migrationZero);
  return {
    close: () => database.close(),
    integrityCheck: () => database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check === "ok",
  };
};
