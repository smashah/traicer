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
);`;

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

interface DeliveryObjectRow {
  readonly ciphertext_hash: string;
  readonly expires_at: number;
}

interface TraceObjectRow {
  readonly ciphertext_hash: string;
  readonly client_manifest_id: string;
  readonly signed_manifest_json: string;
  readonly trace_id: string;
}

export interface SafeEvent {
  readonly createdAt: string;
  readonly details: Readonly<Record<string, boolean | number | string>>;
  readonly kind: string;
  readonly sequence: number;
}

export interface SafeTraceSummary {
  readonly capturedAt: string;
  readonly state: LifecycleState;
  readonly traceId: string;
  readonly updatedAt: string;
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

  const recordEvent = (
    kind: string,
    details: Readonly<Record<string, boolean | number | string>> = {}
  ): void => {
    database
      .query<never, [string, string, number]>(`
        INSERT INTO safe_events (kind, safe_details, created_at) VALUES (?, ?, ?)
      `)
      .run(kind, JSON.stringify(details), Date.now());
    database
      .query<never, []>(`
        DELETE FROM safe_events WHERE sequence NOT IN (
          SELECT sequence FROM safe_events ORDER BY sequence DESC LIMIT 500
        )
      `)
      .run();
  };

  const recordObserved = (traceId: string, capturedAt: string): void => {
    database
      .query<never, [string, string, number]>(`
        INSERT INTO trace_lifecycle (trace_id, state, captured_at, updated_at)
        VALUES (?, 'observed', ?, ?)
        ON CONFLICT(trace_id) DO NOTHING
      `)
      .run(traceId, capturedAt, Date.now());
    recordEvent("queue.changed", { state: "observed" });
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
    recordEvent("queue.changed", { safeErrorCode: code, stage, state: "failed" });
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
    recordEvent("manifest.committed", { committed: true });
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
    committedManifests: (limit = 10_000): readonly SignedSafeManifest[] =>
      database
        .query<{ readonly signed_manifest_json: string }, [number]>(`
          SELECT signed_manifest_json FROM manifest_outbox
          WHERE committed_at IS NOT NULL ORDER BY committed_at ASC LIMIT ?
        `)
        .all(Math.min(Math.max(limit, 1), 10_000))
        .map((row) => JSON.parse(row.signed_manifest_json) as SignedSafeManifest),
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
    eventsAfter: (sequence = 0): readonly SafeEvent[] =>
      database
        .query<{
          readonly sequence: number;
          readonly kind: string;
          readonly safe_details: string;
          readonly created_at: number;
        }, [number]>(`
          SELECT sequence, kind, safe_details, created_at
          FROM safe_events WHERE sequence > ? ORDER BY sequence ASC LIMIT 100
        `)
        .all(sequence)
        .map((row) => ({
          createdAt: new Date(row.created_at).toISOString(),
          details: JSON.parse(row.safe_details) as Readonly<Record<string, boolean | number | string>>,
          kind: row.kind,
          sequence: row.sequence,
        })),
    expiredDeliveryObjects: (at = Date.now()): readonly {
      readonly ciphertextHash: string;
      readonly expiresAt: string;
    }[] =>
      database
        .query<DeliveryObjectRow, [number]>(`
          SELECT ciphertext_hash, expires_at FROM delivery_objects
          WHERE deleted_at IS NULL AND expires_at <= ? ORDER BY expires_at ASC
        `)
        .all(at)
        .map((row) => ({
          ciphertextHash: row.ciphertext_hash,
          expiresAt: new Date(row.expires_at).toISOString(),
        })),
    lifecycleState: (traceId: string): LifecycleState | undefined =>
      database
        .query<LifecycleRow, [string]>(
          "SELECT state FROM trace_lifecycle WHERE trace_id = ?"
        )
        .get(traceId)?.state,
    traceObject: (traceId: string): {
      readonly ciphertextHash: string;
      readonly clientManifestId: string;
      readonly signedManifest: SignedSafeManifest;
      readonly traceId: string;
    } | undefined => {
      const row = database.query<TraceObjectRow, [string]>(`
        SELECT lifecycle.trace_id, lifecycle.ciphertext_hash, lifecycle.client_manifest_id,
               outbox.signed_manifest_json
        FROM trace_lifecycle lifecycle
        JOIN manifest_outbox outbox ON outbox.client_manifest_id = lifecycle.client_manifest_id
        WHERE lifecycle.trace_id = ? AND lifecycle.state = 'committed' LIMIT 1
      `).get(traceId);
      return row ? {
        ciphertextHash: row.ciphertext_hash,
        clientManifestId: row.client_manifest_id,
        signedManifest: JSON.parse(row.signed_manifest_json) as SignedSafeManifest,
        traceId: row.trace_id,
      } : undefined;
    },
    tombstoneTrace: (traceId: string, clientManifestId: string, reasonCode: string): void => {
      database.transaction(() => {
        database.query<never, [string, number, string]>(`
          INSERT INTO manifest_tombstones (client_manifest_id, tombstoned_at, safe_reason_code)
          VALUES (?, ?, ?) ON CONFLICT(client_manifest_id) DO NOTHING
        `).run(clientManifestId, Date.now(), reasonCode);
        database.query<never, [string]>("DELETE FROM manifest_outbox WHERE client_manifest_id = ?")
          .run(clientManifestId);
        database.query<never, [string]>("DELETE FROM trace_lifecycle WHERE trace_id = ?")
          .run(traceId);
      })();
      recordEvent("manifest.tombstoned", { deleted: true });
    },
    reconcile: async (remote: MarketplaceManifestSink): Promise<number> => {
      let committed = 0;
      for (const row of pendingRows()) {
        await submitRow(remote, row);
        committed += 1;
      }
      return committed;
    },
    recordDeliveryObject: (ciphertextHash: string, expiresAt: string): void => {
      const expiry = Date.parse(expiresAt);
      if (!Number.isFinite(expiry)) throw new Error("Delivery object expiry is invalid");
      database
        .query<never, [string, number, number]>(`
          INSERT INTO delivery_objects (ciphertext_hash, expires_at, created_at)
          VALUES (?, ?, ?) ON CONFLICT(ciphertext_hash) DO NOTHING
        `)
        .run(ciphertextHash, expiry, Date.now());
    },
    markDeliveryObjectDeleted: (ciphertextHash: string): void => {
      database
        .query<never, [number, string]>(`
          UPDATE delivery_objects SET deleted_at = ? WHERE ciphertext_hash = ?
        `)
        .run(Date.now(), ciphertextHash);
    },
    multipartJournal: {
      clear: (ciphertextHash: string): void => {
        database.query<never, [string]>("DELETE FROM multipart_uploads WHERE ciphertext_hash = ?")
          .run(ciphertextHash);
      },
      load: (ciphertextHash: string): { readonly parts: readonly { readonly eTag: string; readonly partNumber: number }[]; readonly uploadId: string } | undefined => {
        const row = database.query<{ readonly parts_json: string; readonly upload_id: string }, [string]>(
          "SELECT upload_id, parts_json FROM multipart_uploads WHERE ciphertext_hash = ?"
        ).get(ciphertextHash);
        return row ? {
          parts: JSON.parse(row.parts_json) as readonly { readonly eTag: string; readonly partNumber: number }[],
          uploadId: row.upload_id,
        } : undefined;
      },
      recordPart: (ciphertextHash: string, partNumber: number, eTag: string): void => {
        const current = database.query<{ readonly parts_json: string }, [string]>(
          "SELECT parts_json FROM multipart_uploads WHERE ciphertext_hash = ?"
        ).get(ciphertextHash);
        if (!current) throw new Error("Multipart upload journal is missing");
        const parts = JSON.parse(current.parts_json) as { eTag: string; partNumber: number }[];
        const next = [...parts.filter((part) => part.partNumber !== partNumber), { eTag, partNumber }]
          .sort((left, right) => left.partNumber - right.partNumber);
        database.query<never, [string, number, string]>(`
          UPDATE multipart_uploads SET parts_json = ?, updated_at = ? WHERE ciphertext_hash = ?
        `).run(JSON.stringify(next), Date.now(), ciphertextHash);
      },
      start: (ciphertextHash: string, uploadId: string): void => {
        database.query<never, [string, string, number]>(`
          INSERT INTO multipart_uploads (ciphertext_hash, upload_id, updated_at)
          VALUES (?, ?, ?) ON CONFLICT(ciphertext_hash) DO UPDATE SET
            upload_id = excluded.upload_id, parts_json = '[]', updated_at = excluded.updated_at
        `).run(ciphertextHash, uploadId, Date.now());
      },
    },
    recordEvent,
    recordEncrypted,
    recordCommitted,
    recordFailure,
    recordManifestPending,
    recordObserved,
    traces: (limit = 50, offset = 0): readonly SafeTraceSummary[] =>
      database
        .query<{
          readonly captured_at: string;
          readonly state: LifecycleState;
          readonly trace_id: string;
          readonly updated_at: number;
        }, [number, number]>(`
          SELECT trace_id, state, captured_at, updated_at
          FROM trace_lifecycle ORDER BY updated_at DESC LIMIT ? OFFSET ?
        `)
        .all(Math.min(Math.max(limit, 1), 100), Math.max(offset, 0))
        .map((row) => ({
          capturedAt: row.captured_at,
          state: row.state,
          traceId: row.trace_id,
          updatedAt: new Date(row.updated_at).toISOString(),
        })),
  };
};
