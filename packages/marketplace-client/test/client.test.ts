import { describe, expect, test } from "bun:test";

import type { SignedSafeManifest } from "@traice/domain";

import {
  assertSafeManifestPayload,
  createMarketplaceClient,
  createMarketplaceManifestClient,
} from "../src";

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

  test("uses the versioned Traicer routes for device and readiness operations", async () => {
    const requests: Request[] = [];
    const client = createMarketplaceClient({
      apiBaseUrl: "https://api.traice.market",
      credential: "device-capability",
      fetch: async (request) => {
        requests.push(request);
        return Response.json({ data: { id: "device-1", status: "active" }, success: true });
      },
    });
    await client.registerDevice({
      adapters: ["anthropic-messages/1"],
      clientVersion: "1.0.0",
      name: "seller machine",
      operatingSystemClass: "macos",
      publicKey: "public-key",
      publicKeyFingerprint: "fingerprint",
    });
    await client.commitCapturePolicy({
      deviceId: "device-1",
      eligibilityRules: { unsupportedEndpoints: "deny" },
      endpointAllowlist: ["https://api.anthropic.com/v1/messages"],
      redactionProfile: "strict-default",
      repositoryRules: { declaration: "explicit clients only" },
      signature: "signature",
      signatureAlgorithm: "Ed25519",
      status: "active",
    });
    await client.commitDryRun({
      adapter: "anthropic-messages/1",
      capturePolicyId: "policy-1",
      deviceId: "device-1",
      fixtureVersion: "synthetic/1",
      results: { forwarded: true, persisted: true },
      runAt: "2026-07-13T18:00:00.000Z",
      signature: "signature",
      signatureAlgorithm: "Ed25519",
      status: "passed",
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/v1/traicer/devices",
      "/api/v1/traicer/capture-policy",
      "/api/v1/traicer/capture-dry-runs",
    ]);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer device-capability")).toBeTrue();
  });
});
