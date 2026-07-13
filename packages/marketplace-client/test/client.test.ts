import { describe, expect, test } from "bun:test";

import type { SignedSafeManifest } from "@traice/domain";

import { assertSafeManifestPayload, createMarketplaceManifestClient } from "../src";

const signedManifest = {
  manifest: {
    adapter: "openai-responses/1",
    bucketAlias: "seller-store-01",
    canonicalHash: "a".repeat(64),
    capturePolicyId: "018f1f0d-91aa-7b64-bb02-7db61861b18c",
    capturedAt: "2026-07-13T12:00:00.000Z",
    ciphertextHash: "b".repeat(64),
    client: "codex",
    clientManifestId: "018f1f0d-91aa-7b64-bb02-7db61861b18e",
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
} satisfies SignedSafeManifest;

describe("marketplace manifest client", () => {
  test("sends exact safe fields and keeps credential in the authorization header", async () => {
    let recorded: Request | undefined;
    const client = createMarketplaceManifestClient({
      apiBaseUrl: "https://api.traice.market",
      credential: "trc_test_secret",
      fetch: async (request) => {
        recorded = request instanceof Request ? request : new Request(request);
        return new Response(JSON.stringify({ success: true }), { status: 202 });
      },
    });
    await client.submit({ idempotencyKey: "manifest:test:1", manifests: [signedManifest] });

    expect(recorded?.headers.get("authorization")).toBe("Bearer trc_test_secret");
    const body = await recorded?.json();
    expect(JSON.stringify(body)).not.toContain("trc_test_secret");
    expect(JSON.stringify(body)).not.toContain("RAW_CANARY_DO_NOT_EGRESS");
  });

  test("rejects generic storage locators and secrets", () => {
    expect(() =>
      assertSafeManifestPayload({ ...signedManifest, endpoint: "https://s3.test" })
    ).toThrow("prohibited field");
    expect(() =>
      assertSafeManifestPayload({ ...signedManifest, secretAccessKey: "secret" })
    ).toThrow("prohibited field");
  });
});
