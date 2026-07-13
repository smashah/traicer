import { sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import { operationalMigrations } from "./generated-migrations";

interface AppliedMigration {
  readonly createdAt: number;
}

export const migrateOperationalState = <TSchema extends Record<string, unknown>>(
  db: BunSQLiteDatabase<TSchema>
): void => {
  db.run(sql.raw(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `));

  const latest = db
    .get<AppliedMigration>(
      sql.raw(`
        SELECT created_at AS createdAt
        FROM __drizzle_migrations
        ORDER BY created_at DESC
        LIMIT 1
      `)
    )
    ?.createdAt;

  db.transaction((tx) => {
    for (const migration of operationalMigrations) {
      if (latest !== undefined && latest >= migration.folderMillis) {
        continue;
      }
      for (const statement of migration.sql) {
        if (statement.trim()) {
          tx.run(sql.raw(statement));
        }
      }
      tx.run(sql`
        INSERT INTO __drizzle_migrations (hash, created_at)
        VALUES (${migration.hash}, ${migration.folderMillis})
      `);
    }
  });
};
