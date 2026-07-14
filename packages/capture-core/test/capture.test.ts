import { describe, expect, test } from "bun:test";

import {
  decryptTraceEnvelope,
  generateDeviceSigningKeyPair,
  sha256Hex,
  verifyBytes,
} from "@traice/crypto";
import type {
  CapturePolicyV1,
  ObservedProviderExchange,
  SignedSafeManifest,
} from "@traice/domain";
import { canonicalBytes } from "@traice/privacy-pipeline";

import { createCaptureEngine } from "../src";

const policy: CapturePolicyV1 = {
  allowedMethods: ["POST"],
  allowedPaths: ["/v1/responses"],
  capturePolicyId: "018f1f0d-91aa-7b64-bb02-7db61861b18c",
  pipelineVersion: "pipeline/1",
  policyVersion: "policy/1",
  redactionProfile: "strict-default",
  schema: "traice.capture-policy/1",
  successfulResponsesOnly: true,
};

describe("capture engine", () => {
  test("redacts, encrypts, verifies seller storage and signs content-free egress", async () => {
    const keys = await generateDeviceSigningKeyPair();
    const wrappingKey = crypto.getRandomValues(new Uint8Array(32));
    let stored: Uint8Array | undefined;
    let submitted: readonly SignedSafeManifest[] = [];
    const engine = createCaptureEngine(
      {
        bucketAlias: "seller-store-01",
        deviceId: "018f1f0d-91aa-7b64-bb02-7db61861b18d",
        policy,
        signerKeyId: keys.keyId,
        signingPrivateKey: keys.privateKey,
        wrappingKey,
      },
      {
        putEnvelope: async ({ bytes, ciphertextHash }) => {
          stored = bytes.slice();
          expect(await sha256Hex(stored)).toBe(ciphertextHash);
          return {
            encryptedBytes: stored.byteLength,
            integrityAssurance: "full_readback",
            objectCommitment: await sha256Hex(`objects/${ciphertextHash}.trce`),
            storageCapabilityProfileId: "fixture-profile-v1",
          };
        },
      },
      {
        submit: async ({ manifests }) => {
          submitted = manifests;
        },
      }
    );
    const observed: ObservedProviderExchange = {
      adapter: "openai-responses/1",
      capturedAt: "2026-07-13T12:41:20.000Z",
      client: "codex",
      method: "POST",
      model: "gpt-test",
      path: "/v1/responses",
      provider: "openai",
      requestBody: {
        api_key: "sk-abcdefghijklmnop",
        input: "RAW_CANARY_DO_NOT_EGRESS seller@example.com",
      },
      requestHeaders: { authorization: "Bearer provider-secret" },
      responseBody: { output: [{ content: "synthetic provider response" }] },
      responseStatus: 200,
      traceId: "trace-fixture-1",
      usage: { inputTokens: 3, outputTokens: 4 },
    };

    const outcome = await engine.capture(observed);
    expect(stored).toBeDefined();
    const plaintext = await decryptTraceEnvelope({ envelope: stored!, wrappingKey });
    const decoded = new TextDecoder().decode(plaintext);
    expect(decoded).toContain("RAW_CANARY_DO_NOT_EGRESS");
    expect(decoded).not.toContain("seller@example.com");
    expect(decoded).not.toContain("sk-abcdefghijklmnop");
    expect(submitted).toHaveLength(1);
    const egress = JSON.stringify(submitted);
    expect(egress).not.toContain("RAW_CANARY_DO_NOT_EGRESS");
    expect(egress).not.toContain("provider-secret");
    expect(egress).not.toContain("seller@example.com");
    expect(
      await verifyBytes(
        keys.publicKey,
        outcome.manifest.signature,
        canonicalBytes(outcome.manifest.manifest)
      )
    ).toBe(true);
  });
});
