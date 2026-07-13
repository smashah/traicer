import { Database } from "bun:sqlite";

import type { MarketplaceManifestSink } from "@traice/capture-core";
import type { SignedSafeManifest } from "@traice/domain";

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
  ON manifest_outbox(committed_at, created_at);`;

type LifecycleState = "observed" | "encrypted" | "manifest_pending" | "committed" | "failed";

interface LifecycleRow {
  readonly state: LifecycleState;
}

interface PendingManifestRow {
  readonly client_manifest_id: string;
  readonly idempotency_key: string;
  readonly signed_manifest_json: string;
  readonly trace_id: string;
}

const safeErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "unknown";
  if (message.includes("failed with")) {
    return `remote_${message.replace(/\D/g, "").slice(0, 3) || "error"}`;
  }
  return "remote_unavailable";
};

export const openOperationalState = (path: string) => {
  const database = new Database(path, { create: true, strict: true });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  database.exec(migrationZero);

  const recordObserved = (traceId: string, capturedAt: string): void => {
    database
      .query<never, [string, string, number]>(`
        INSERT INTO trace_lifecycle (trace_id, state, captured_at, updated_at)
        VALUES (?, 'observed', ?, ?)
        ON CONFLICT(trace_id) DO NOTHING
      `)
      .run(traceId, capturedAt, Date.now());
  };

  const recordEncrypted = (
    traceId: string,
    canonicalHash: string,
    ciphertextHash: string
  ): void => {
    database
      .query<never, [string, string, number, string]>(`
        UPDATE trace_lifecycle
        SET state = 'encrypted', canonical_hash = ?, ciphertext_hash = ?, updated_at = ?
        WHERE trace_id = ?
      `)
      .run(canonicalHash, ciphertextHash, Date.now(), traceId);
  };

  const recordFailure = (traceId: string, stage: string, code: string): void => {
    database
      .query<never, [string, string, number, string]>(`
        UPDATE trace_lifecycle
        SET state = 'failed', failure_stage = ?, safe_error_code = ?, updated_at = ?
        WHERE trace_id = ?
      `)
      .run(stage, code, Date.now(), traceId);
  };

  const recordManifestPending = (traceId: string, clientManifestId: string): void => {
    database
      .query<never, [string, number, string]>(`
        UPDATE trace_lifecycle
        SET state = 'manifest_pending', client_manifest_id = ?, updated_at = ?
        WHERE trace_id = ?
      `)
      .run(clientManifestId, Date.now(), traceId);
  };

  const recordCommitted = (traceId: string): void => {
    database
      .query<never, [number, string]>(`
        UPDATE trace_lifecycle SET state = 'committed', updated_at = ? WHERE trace_id = ?
      `)
      .run(Date.now(), traceId);
  };

  const pendingRows = (): readonly PendingManifestRow[] =>
    database
      .query<PendingManifestRow, []>(`
        SELECT client_manifest_id, idempotency_key, signed_manifest_json, trace_id
        FROM manifest_outbox
        WHERE committed_at IS NULL
        ORDER BY created_at ASC
      `)
      .all();

  const enqueue = (idempotencyKey: string, signed: SignedSafeManifest): void => {
    const now = Date.now();
    const traceId =
      database
        .query<{ readonly trace_id: string }, [string]>(`
          SELECT trace_id FROM trace_lifecycle WHERE client_manifest_id = ? LIMIT 1
        `)
        .get(signed.manifest.clientManifestId)?.trace_id ?? signed.manifest.clientManifestId;
    database.transaction(() => {
      if (traceId === signed.manifest.clientManifestId) {
        recordObserved(traceId, signed.manifest.capturedAt);
        recordEncrypted(traceId, signed.manifest.canonicalHash, signed.manifest.ciphertextHash);
        recordManifestPending(traceId, signed.manifest.clientManifestId);
      }
      database
        .query<never, [string, string, string, string, number]>(`
          INSERT INTO manifest_outbox (
            client_manifest_id, trace_id, idempotency_key, signed_manifest_json, created_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(client_manifest_id) DO NOTHING
        `)
        .run(
          signed.manifest.clientManifestId,
          traceId,
          idempotencyKey,
          JSON.stringify(signed),
          now
        );
    })();
  };

  const markCommitted = (row: PendingManifestRow): void => {
    const now = Date.now();
    database.transaction(() => {
      database
        .query<never, [number, string]>(`
          UPDATE manifest_outbox SET committed_at = ?, safe_error_code = NULL
          WHERE client_manifest_id = ? AND committed_at IS NULL
        `)
        .run(now, row.client_manifest_id);
      database
        .query<never, [number, string]>(`
          UPDATE trace_lifecycle SET state = 'committed', updated_at = ? WHERE trace_id = ?
        `)
        .run(now, row.trace_id);
    })();
  };

  const markAttemptFailed = (row: PendingManifestRow, error: unknown): void => {
    database
      .query<never, [number, string, string]>(`
        UPDATE manifest_outbox
        SET attempt_count = attempt_count + 1, last_attempt_at = ?, safe_error_code = ?
        WHERE client_manifest_id = ? AND committed_at IS NULL
      `)
      .run(Date.now(), safeErrorCode(error), row.client_manifest_id);
  };

  const submitRow = async (
    remote: MarketplaceManifestSink,
    row: PendingManifestRow
  ): Promise<void> => {
    const signed = JSON.parse(row.signed_manifest_json) as SignedSafeManifest;
    try {
      await remote.submit({ idempotencyKey: row.idempotency_key, manifests: [signed] });
      markCommitted(row);
    } catch (error) {
      markAttemptFailed(row, error);
      throw error;
    }
  };

  return {
    close: () => database.close(),
    counts: () => ({
      committed: database
        .query<{ readonly count: number }, []>(
          "SELECT count(*) AS count FROM manifest_outbox WHERE committed_at IS NOT NULL"
        )
        .get()?.count ?? 0,
      pending: database
        .query<{ readonly count: number }, []>(
          "SELECT count(*) AS count FROM manifest_outbox WHERE committed_at IS NULL"
        )
        .get()?.count ?? 0,
    }),
    createDurableManifestSink: (remote: MarketplaceManifestSink): MarketplaceManifestSink => ({
      submit: async (input) => {
        for (const signed of input.manifests) {
          enqueue(input.idempotencyKey, signed);
        }
        const rows = pendingRows().filter((row) =>
          input.manifests.some(
            (signed) => signed.manifest.clientManifestId === row.client_manifest_id
          )
        );
        for (const row of rows) {
          await submitRow(remote, row);
        }
      },
    }),
    integrityCheck: () =>
      database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
        ?.integrity_check === "ok",
    lifecycleState: (traceId: string): LifecycleState | undefined =>
      database
        .query<LifecycleRow, [string]>(
          "SELECT state FROM trace_lifecycle WHERE trace_id = ?"
        )
        .get(traceId)?.state,
    reconcile: async (remote: MarketplaceManifestSink): Promise<number> => {
      let committed = 0;
      for (const row of pendingRows()) {
        await submitRow(remote, row);
        committed += 1;
      }
      return committed;
    },
    recordEncrypted,
    recordCommitted,
    recordFailure,
    recordManifestPending,
    recordObserved,
  };
};
