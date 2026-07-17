import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { SignedSafeManifest } from "@traice/domain";

import { openOperationalState } from "../src";
import legacySchemaSql from "./fixtures/legacy-schema.sql" with { type: "text" };

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        Bun.file(`${path}${suffix}`).delete();
      } catch {
        // The SQLite sidecar may not exist.
      }
    }
  }
});

const signed = (id: string): SignedSafeManifest => ({
  manifest: {
    adapter: "openai-responses/1",
    bucketAlias: "seller-store-01",
    canonicalHash: "a".repeat(64),
    capturePolicyId: "018f1f0d-91aa-7b64-bb02-7db61861b18c",
    capturedAt: "2026-07-13T12:00:00.000Z",
    ciphertextHash: "b".repeat(64),
    client: "codex",
    clientManifestId: id,
    deviceId: "018f1f0d-91aa-7b64-bb02-7db61861b18d",
    encryptedBytes: 512,
    inputTokens: 2,
    model: "gpt-test",
    objectLocatorCommitment: "c".repeat(64),
    outputTokens: 3,
    pipelineVersion: "pipeline/1",
    policyVersion: "policy/1",
    provider: "openai",
    redaction: {
      detectorVersion: "builtin/1",
      profile: "strict-default",
      replacementCounts: { EMAIL: 1 },
    },
    schema: "traice.manifest/1",
    signerKeyId: "key-test",
    storageCapabilityProfileId: "storage-profile-v1",
    storageIntegrityAssurance: "full_readback",
    storageKind: "s3_compatible",
    toolCallCount: 0,
    verificationTier: "self_attested",
  },
  signature: "signature".repeat(8),
});

describe("durable manifest outbox", () => {
  test("baselines a pre-Drizzle database without losing typed state", () => {
    const path = `/tmp/traicer-state-${crypto.randomUUID()}.db`;
    paths.push(path);
    const id = crypto.randomUUID();
    const manifest = signed(id);
    const now = Date.now();

    const legacy = new Database(path, { create: true, strict: true });
    legacy.exec(legacySchemaSql);
    legacy
      .query<never, [string, string, string, string, string, string, number]>(`
        INSERT INTO trace_lifecycle (
          trace_id, state, canonical_hash, ciphertext_hash, client_manifest_id,
          captured_at, updated_at
        ) VALUES (?, 'committed', ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        manifest.manifest.canonicalHash,
        manifest.manifest.ciphertextHash,
        id,
        manifest.manifest.capturedAt,
        now
      );
    legacy
      .query<never, [string, string, string, string, number, number]>(`
        INSERT INTO manifest_outbox (
          client_manifest_id, trace_id, idempotency_key, signed_manifest_json,
          committed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(id, id, `manifest:${id}`, JSON.stringify(manifest), now, now);
    legacy.close();

    const migrated = openOperationalState(path);
    expect(migrated.counts()).toEqual({ committed: 1, pending: 0 });
    expect(migrated.lifecycleState(id)).toBe("committed");
    expect(migrated.committedManifests()).toEqual([manifest]);
    migrated.close();

    const reopened = openOperationalState(path);
    expect(reopened.counts()).toEqual({ committed: 1, pending: 0 });
    reopened.close();

    const verified = new Database(path, { strict: true });
    expect(
      verified
        .query<{ readonly count: number }, []>(
          "SELECT count(*) AS count FROM __drizzle_migrations"
        )
        .get()?.count
    ).toBe(2);
    verified.close();
  });

  test("retains a safe manifest after remote failure and reconciles it once", async () => {
    const path = `/tmp/traicer-state-${crypto.randomUUID()}.db`;
    paths.push(path);
    const state = openOperationalState(path);
    const id = crypto.randomUUID();
    const sink = state.createDurableManifestSink({
      submit: async () => {
        throw new Error("Marketplace manifest submission failed with 503");
      },
    });

    await expect(
      sink.submit({ idempotencyKey: `manifest:${id}`, manifests: [signed(id)] })
    ).rejects.toThrow("503");
    expect(state.counts()).toEqual({ committed: 0, pending: 1 });
    expect(state.lifecycleState(id)).toBe("manifest_pending");

    let submissions = 0;
    expect(
      await state.reconcile({
        submit: async () => {
          submissions += 1;
        },
      })
    ).toBe(1);
    expect(submissions).toBe(1);
    expect(state.counts()).toEqual({ committed: 1, pending: 0 });
    expect(state.lifecycleState(id)).toBe("committed");
    expect(state.traces(10, 0)[0]).toMatchObject({ state: "committed" });
    expect(state.eventsAfter(0).some((event) => event.kind === "queue.changed")).toBeTrue();
    expect(await state.reconcile({ submit: async () => (submissions += 1) })).toBe(0);
    expect(submissions).toBe(1);
    state.close();
  });

  test("retains temporary delivery objects until their expiry cleanup succeeds", () => {
    const path = `/tmp/traicer-state-${crypto.randomUUID()}.db`;
    paths.push(path);
    const state = openOperationalState(path);
    const hash = "d".repeat(64);
    state.recordDeliveryObject(hash, new Date(Date.now() - 1_000).toISOString());
    expect(state.expiredDeliveryObjects()).toEqual([
      { ciphertextHash: hash, expiresAt: expect.any(String) },
    ]);
    state.markDeliveryObjectDeleted(hash);
    expect(state.expiredDeliveryObjects()).toEqual([]);
    state.close();
  });

  test("persists multipart progress and removes trace references after a tombstone", async () => {
    const path = `/tmp/traicer-state-${crypto.randomUUID()}.db`;
    paths.push(path);
    const state = openOperationalState(path);
    const id = crypto.randomUUID();
    await state.createDurableManifestSink({ submit: async () => undefined })
      .submit({ idempotencyKey: `manifest:${id}`, manifests: [signed(id)] });
    expect(state.traceObject(id)?.clientManifestId).toBe(id);

    const hash = "e".repeat(64);
    state.multipartJournal.start(hash, "upload-1");
    state.multipartJournal.recordPart(hash, 1, '"etag-1"');
    expect(state.multipartJournal.load(hash)).toEqual({
      parts: [{ eTag: '"etag-1"', partNumber: 1 }],
      uploadId: "upload-1",
    });
    state.multipartJournal.clear(hash);
    expect(state.multipartJournal.load(hash)).toBeUndefined();

    state.tombstoneTrace(id, id, "seller_requested");
    expect(state.traceObject(id)).toBeUndefined();
    expect(state.counts()).toEqual({ committed: 0, pending: 0 });
    state.close();
  });
});
