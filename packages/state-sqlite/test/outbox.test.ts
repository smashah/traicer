import { afterEach, describe, expect, test } from "bun:test";

import type { SignedSafeManifest } from "@traice/domain";

import { openOperationalState } from "../src";

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
    expect(await state.reconcile({ submit: async () => (submissions += 1) })).toBe(0);
    expect(submissions).toBe(1);
    state.close();
  });
});
