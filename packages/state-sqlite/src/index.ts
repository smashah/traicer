import { Database } from "bun:sqlite";

import type { MarketplaceManifestSink } from "@traice/capture-core";
import type { SignedSafeManifest } from "@traice/domain";
import { and, asc, count, desc, eq, gt, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateOperationalState } from "./migrate";
import {
  deliveryObjects,
  type LifecycleState,
  manifestOutbox,
  manifestTombstones,
  multipartUploads,
  operationalSchema,
  type SafeDetails,
  safeEvents,
  traceLifecycle,
} from "./schema";

export * from "./schema";

type PendingManifest = Pick<
  typeof manifestOutbox.$inferSelect,
  "clientManifestId" | "idempotencyKey" | "signedManifest" | "traceId"
>;

export interface SafeEvent {
  readonly createdAt: string;
  readonly details: SafeDetails;
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

const boundedLimit = (limit: number, maximum: number) =>
  Math.min(Math.max(limit, 1), maximum);

export const openOperationalState = (path: string) => {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  const db = drizzle(sqlite, { schema: operationalSchema });
  migrateOperationalState(db);

  const trimEvents = (): void => {
    const boundary = db
      .select({ sequence: safeEvents.sequence })
      .from(safeEvents)
      .orderBy(desc(safeEvents.sequence))
      .limit(1)
      .offset(499)
      .get();
    if (boundary) {
      db.delete(safeEvents).where(lt(safeEvents.sequence, boundary.sequence)).run();
    }
  };

  const recordEvent = (kind: string, details: SafeDetails = {}): void => {
    db.insert(safeEvents)
      .values({ createdAt: Date.now(), kind, safeDetails: details })
      .run();
    trimEvents();
  };

  const recordObserved = (traceId: string, capturedAt: string): void => {
    db.insert(traceLifecycle)
      .values({
        capturedAt,
        state: "observed",
        traceId,
        updatedAt: Date.now(),
      })
      .onConflictDoNothing({ target: traceLifecycle.traceId })
      .run();
    recordEvent("queue.changed", { state: "observed" });
  };

  const recordEncrypted = (
    traceId: string,
    canonicalHash: string,
    ciphertextHash: string
  ): void => {
    db.update(traceLifecycle)
      .set({
        canonicalHash,
        ciphertextHash,
        state: "encrypted",
        updatedAt: Date.now(),
      })
      .where(eq(traceLifecycle.traceId, traceId))
      .run();
  };

  const recordFailure = (traceId: string, stage: string, code: string): void => {
    db.update(traceLifecycle)
      .set({
        failureStage: stage,
        safeErrorCode: code,
        state: "failed",
        updatedAt: Date.now(),
      })
      .where(eq(traceLifecycle.traceId, traceId))
      .run();
    recordEvent("queue.changed", { safeErrorCode: code, stage, state: "failed" });
  };

  const recordManifestPending = (traceId: string, clientManifestId: string): void => {
    db.update(traceLifecycle)
      .set({
        clientManifestId,
        state: "manifest_pending",
        updatedAt: Date.now(),
      })
      .where(eq(traceLifecycle.traceId, traceId))
      .run();
  };

  const recordCommitted = (traceId: string): void => {
    db.update(traceLifecycle)
      .set({ state: "committed", updatedAt: Date.now() })
      .where(eq(traceLifecycle.traceId, traceId))
      .run();
    recordEvent("manifest.committed", { committed: true });
  };

  const pendingRows = (): readonly PendingManifest[] =>
    db
      .select({
        clientManifestId: manifestOutbox.clientManifestId,
        idempotencyKey: manifestOutbox.idempotencyKey,
        signedManifest: manifestOutbox.signedManifest,
        traceId: manifestOutbox.traceId,
      })
      .from(manifestOutbox)
      .where(isNull(manifestOutbox.committedAt))
      .orderBy(asc(manifestOutbox.createdAt))
      .all();

  const enqueue = (idempotencyKey: string, signed: SignedSafeManifest): void => {
    const now = Date.now();
    const existing = db
      .select({ traceId: traceLifecycle.traceId })
      .from(traceLifecycle)
      .where(eq(traceLifecycle.clientManifestId, signed.manifest.clientManifestId))
      .limit(1)
      .get();
    const traceId = existing?.traceId ?? signed.manifest.clientManifestId;

    db.transaction((tx) => {
      if (!existing) {
        tx.insert(traceLifecycle)
          .values({
            canonicalHash: signed.manifest.canonicalHash,
            capturedAt: signed.manifest.capturedAt,
            ciphertextHash: signed.manifest.ciphertextHash,
            clientManifestId: signed.manifest.clientManifestId,
            state: "manifest_pending",
            traceId,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: traceLifecycle.traceId })
          .run();
        tx.insert(safeEvents)
          .values({
            createdAt: now,
            kind: "queue.changed",
            safeDetails: { state: "observed" },
          })
          .run();
      }
      tx.insert(manifestOutbox)
        .values({
          clientManifestId: signed.manifest.clientManifestId,
          createdAt: now,
          idempotencyKey,
          signedManifest: signed,
          traceId,
        })
        .onConflictDoNothing({ target: manifestOutbox.clientManifestId })
        .run();
    });
    if (!existing) {
      trimEvents();
    }
  };

  const markCommitted = (row: PendingManifest): void => {
    const now = Date.now();
    db.transaction((tx) => {
      tx.update(manifestOutbox)
        .set({ committedAt: now, safeErrorCode: null })
        .where(
          and(
            eq(manifestOutbox.clientManifestId, row.clientManifestId),
            isNull(manifestOutbox.committedAt)
          )
        )
        .run();
      tx.update(traceLifecycle)
        .set({ state: "committed", updatedAt: now })
        .where(eq(traceLifecycle.traceId, row.traceId))
        .run();
    });
  };

  const markAttemptFailed = (row: PendingManifest, error: unknown): void => {
    db.update(manifestOutbox)
      .set({
        attemptCount: sql`${manifestOutbox.attemptCount} + 1`,
        lastAttemptAt: Date.now(),
        safeErrorCode: safeErrorCode(error),
      })
      .where(
        and(
          eq(manifestOutbox.clientManifestId, row.clientManifestId),
          isNull(manifestOutbox.committedAt)
        )
      )
      .run();
  };

  const submitRow = async (
    remote: MarketplaceManifestSink,
    row: PendingManifest
  ): Promise<void> => {
    try {
      await remote.submit({
        idempotencyKey: row.idempotencyKey,
        manifests: [row.signedManifest],
      });
      markCommitted(row);
    } catch (error) {
      markAttemptFailed(row, error);
      throw error;
    }
  };

  return {
    close: () => sqlite.close(),
    committedManifests: (limit = 10_000): readonly SignedSafeManifest[] =>
      db
        .select({ signedManifest: manifestOutbox.signedManifest })
        .from(manifestOutbox)
        .where(isNotNull(manifestOutbox.committedAt))
        .orderBy(asc(manifestOutbox.committedAt))
        .limit(boundedLimit(limit, 10_000))
        .all()
        .map((row) => row.signedManifest),
    counts: () => ({
      committed:
        db
          .select({ value: count() })
          .from(manifestOutbox)
          .where(isNotNull(manifestOutbox.committedAt))
          .get()?.value ?? 0,
      pending:
        db
          .select({ value: count() })
          .from(manifestOutbox)
          .where(isNull(manifestOutbox.committedAt))
          .get()?.value ?? 0,
    }),
    createDurableManifestSink: (remote: MarketplaceManifestSink): MarketplaceManifestSink => ({
      submit: async (input) => {
        for (const signed of input.manifests) {
          enqueue(input.idempotencyKey, signed);
        }
        const manifestIds = new Set(
          input.manifests.map((signed) => signed.manifest.clientManifestId)
        );
        for (const row of pendingRows().filter((pending) =>
          manifestIds.has(pending.clientManifestId)
        )) {
          await submitRow(remote, row);
        }
      },
    }),
    eventsAfter: (sequence = 0): readonly SafeEvent[] =>
      db
        .select()
        .from(safeEvents)
        .where(gt(safeEvents.sequence, sequence))
        .orderBy(asc(safeEvents.sequence))
        .limit(100)
        .all()
        .map((row) => ({
          createdAt: new Date(row.createdAt).toISOString(),
          details: row.safeDetails,
          kind: row.kind,
          sequence: row.sequence,
        })),
    expiredDeliveryObjects: (at = Date.now()): readonly {
      readonly ciphertextHash: string;
      readonly expiresAt: string;
    }[] =>
      db
        .select({
          ciphertextHash: deliveryObjects.ciphertextHash,
          expiresAt: deliveryObjects.expiresAt,
        })
        .from(deliveryObjects)
        .where(
          and(isNull(deliveryObjects.deletedAt), lte(deliveryObjects.expiresAt, at))
        )
        .orderBy(asc(deliveryObjects.expiresAt))
        .all()
        .map((row) => ({
          ciphertextHash: row.ciphertextHash,
          expiresAt: new Date(row.expiresAt).toISOString(),
        })),
    integrityCheck: () =>
      db.get<{ integrity_check: string }>(sql.raw("PRAGMA integrity_check"))
        ?.integrity_check === "ok",
    lifecycleState: (traceId: string): LifecycleState | undefined =>
      db
        .select({ state: traceLifecycle.state })
        .from(traceLifecycle)
        .where(eq(traceLifecycle.traceId, traceId))
        .limit(1)
        .get()?.state,
    markDeliveryObjectDeleted: (ciphertextHash: string): void => {
      db.update(deliveryObjects)
        .set({ deletedAt: Date.now() })
        .where(eq(deliveryObjects.ciphertextHash, ciphertextHash))
        .run();
    },
    multipartJournal: {
      clear: (ciphertextHash: string): void => {
        db.delete(multipartUploads)
          .where(eq(multipartUploads.ciphertextHash, ciphertextHash))
          .run();
      },
      load: (
        ciphertextHash: string
      ):
        | {
            readonly parts: typeof multipartUploads.$inferSelect.parts;
            readonly uploadId: string;
          }
        | undefined => {
        const row = db
          .select({ parts: multipartUploads.parts, uploadId: multipartUploads.uploadId })
          .from(multipartUploads)
          .where(eq(multipartUploads.ciphertextHash, ciphertextHash))
          .limit(1)
          .get();
        return row ? { parts: row.parts, uploadId: row.uploadId } : undefined;
      },
      recordPart: (ciphertextHash: string, partNumber: number, eTag: string): void => {
        const current = db
          .select({ parts: multipartUploads.parts })
          .from(multipartUploads)
          .where(eq(multipartUploads.ciphertextHash, ciphertextHash))
          .limit(1)
          .get();
        if (!current) {
          throw new Error("Multipart upload journal is missing");
        }
        const parts = [
          ...current.parts.filter((part) => part.partNumber !== partNumber),
          { eTag, partNumber },
        ].sort((left, right) => left.partNumber - right.partNumber);
        db.update(multipartUploads)
          .set({ parts, updatedAt: Date.now() })
          .where(eq(multipartUploads.ciphertextHash, ciphertextHash))
          .run();
      },
      start: (ciphertextHash: string, uploadId: string): void => {
        const now = Date.now();
        db.insert(multipartUploads)
          .values({ ciphertextHash, parts: [], updatedAt: now, uploadId })
          .onConflictDoUpdate({
            set: { parts: [], updatedAt: now, uploadId },
            target: multipartUploads.ciphertextHash,
          })
          .run();
      },
    },
    reconcile: async (remote: MarketplaceManifestSink): Promise<number> => {
      let committed = 0;
      for (const row of pendingRows()) {
        await submitRow(remote, row);
        committed += 1;
      }
      return committed;
    },
    recordCommitted,
    recordDeliveryObject: (ciphertextHash: string, expiresAt: string): void => {
      const expiry = Date.parse(expiresAt);
      if (!Number.isFinite(expiry)) {
        throw new Error("Delivery object expiry is invalid");
      }
      db.insert(deliveryObjects)
        .values({ ciphertextHash, createdAt: Date.now(), expiresAt: expiry })
        .onConflictDoNothing({ target: deliveryObjects.ciphertextHash })
        .run();
    },
    recordEncrypted,
    recordEvent,
    recordFailure,
    recordManifestPending,
    recordObserved,
    tombstoneTrace: (
      traceId: string,
      clientManifestId: string,
      reasonCode: string
    ): void => {
      db.transaction((tx) => {
        tx.insert(manifestTombstones)
          .values({
            clientManifestId,
            safeReasonCode: reasonCode,
            tombstonedAt: Date.now(),
          })
          .onConflictDoNothing({ target: manifestTombstones.clientManifestId })
          .run();
        tx.delete(manifestOutbox)
          .where(eq(manifestOutbox.clientManifestId, clientManifestId))
          .run();
        tx.delete(traceLifecycle).where(eq(traceLifecycle.traceId, traceId)).run();
      });
      recordEvent("manifest.tombstoned", { deleted: true });
    },
    traceObject: (
      traceId: string
    ):
      | {
          readonly ciphertextHash: string;
          readonly clientManifestId: string;
          readonly signedManifest: SignedSafeManifest;
          readonly traceId: string;
        }
      | undefined => {
      const row = db
        .select({
          ciphertextHash: traceLifecycle.ciphertextHash,
          clientManifestId: traceLifecycle.clientManifestId,
          signedManifest: manifestOutbox.signedManifest,
          traceId: traceLifecycle.traceId,
        })
        .from(traceLifecycle)
        .innerJoin(
          manifestOutbox,
          eq(manifestOutbox.clientManifestId, traceLifecycle.clientManifestId)
        )
        .where(
          and(
            eq(traceLifecycle.traceId, traceId),
            eq(traceLifecycle.state, "committed")
          )
        )
        .limit(1)
        .get();
      if (!row?.ciphertextHash || !row.clientManifestId) {
        return undefined;
      }
      return {
        ciphertextHash: row.ciphertextHash,
        clientManifestId: row.clientManifestId,
        signedManifest: row.signedManifest,
        traceId: row.traceId,
      };
    },
    traces: (limit = 50, offset = 0): readonly SafeTraceSummary[] =>
      db
        .select({
          capturedAt: traceLifecycle.capturedAt,
          state: traceLifecycle.state,
          traceId: traceLifecycle.traceId,
          updatedAt: traceLifecycle.updatedAt,
        })
        .from(traceLifecycle)
        .orderBy(desc(traceLifecycle.updatedAt))
        .limit(boundedLimit(limit, 100))
        .offset(Math.max(offset, 0))
        .all()
        .map((row) => ({
          capturedAt: row.capturedAt,
          state: row.state,
          traceId: row.traceId,
          updatedAt: new Date(row.updatedAt).toISOString(),
        })),
  };
};
