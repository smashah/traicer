import { afterEach, describe, expect, test } from "bun:test";

import type { SignedSafeManifest } from "@traice/domain";
import type { ExchangeLabels, SessionLabels } from "@traice/session-labels";

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
    adapter: "anthropic-messages/1",
    bucketAlias: "seller-store-01",
    canonicalHash: "a".repeat(64),
    canonicalTraceSchema: "traice.otel-genai.trace/1",
    capturePolicyId: "018f1f0d-91aa-7b64-bb02-7db61861b18c",
    capturedAt: "2026-10-24T10:00:00.000Z",
    ciphertextHash: "b".repeat(64),
    client: "claude-code",
    clientManifestId: id,
    deviceId: "018f1f0d-91aa-7b64-bb02-7db61861b18d",
    encryptedBytes: 512,
    inputTokens: 2,
    model: "claude-test",
    objectLocatorCommitment: "c".repeat(64),
    outputTokens: 3,
    otelSchemaUrl: "https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev",
    otelSemconvCommit: "b694ec35855d8eccfacd5b09e4b72a808b363038",
    pipelineVersion: "otel-genai/1",
    policyVersion: "policy/1",
    provider: "anthropic",
    provenance: "provider_exchange",
    redaction: { detectorVersion: "builtin/1", profile: "strict-default", replacementCounts: {} },
    schema: "traice.manifest/3",
    signerKeyId: "key-test",
    storageCapabilityProfileId: "storage-profile-v1",
    storageIntegrityAssurance: "full_readback",
    storageKind: "s3_compatible",
    toolCallCount: 0,
    verificationTier: "self_attested",
  },
  signature: "signature".repeat(8),
});

const exchangeLabels: ExchangeLabels = {
  doneClaim: false,
  kind: "agent_step",
  labelerVersion: "session-labels/1",
  languages: ["typescript"],
  schema: "traice.labels.exchange/1",
  steps: [{ activity: "run_tests", result: "test_failure" }],
};

const sessionLabels = (closed: boolean): SessionLabels => ({
  closed,
  counts: {
    acceptedUnits: 0,
    contradictedClaims: 0,
    corrections: 0,
    failToPass: 1,
    failedChecks: 1,
    flakyOrTestEdit: 0,
    permissionDenied: 0,
    skipsAdded: 0,
    suppressionsAdded: 0,
    testTampering: 0,
    unverifiedClaims: 0,
    verifiedUnits: 1,
  },
  exchanges: 3,
  labelerVersion: "session-labels/1",
  languages: ["typescript"],
  outcome: { confidence: 0.9, source: "rule", value: "completed_verified" },
  schema: "traice.labels.session/1",
  userRequests: 1,
  workUnits: 1,
});

describe("session labels", () => {
  test("count only committed manifests behind each session", async () => {
    const path = `/tmp/traicer-labels-${crypto.randomUUID()}.db`;
    paths.push(path);
    const state = openOperationalState(path);
    const sink = state.createDurableManifestSink({ submit: async () => {} });
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids.slice(0, 2)) {
      await sink.submit({ idempotencyKey: `manifest:${id}`, manifests: [signed(id)] });
    }
    for (const id of ids) {
      state.recordTraceLabels({ labels: exchangeLabels, sessionKey: "session-a", traceId: id });
    }
    state.recordSessionLabels({ labels: sessionLabels(false), projectScopeId: "scope-1", sessionKey: "session-a" });
    state.recordSessionLabels({ labels: sessionLabels(true), projectScopeId: "scope-1", sessionKey: "session-a" });

    const rows = state.sessionInventory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ manifestCount: 2, projectScopeId: "scope-1" });
    expect(rows[0]?.labels.closed).toBe(true);

    expect(state.labelsForTrace(ids[0]!)).toMatchObject({
      exchange: { kind: "agent_step" },
      session: { counts: { failToPass: 1 } },
    });
    expect(state.labelsForTrace("missing")).toEqual({});

    state.tombstoneTrace(ids[0]!, ids[0]!, "seller_requested");
    expect(state.labelsForTrace(ids[0]!)).toEqual({});
    expect(state.sessionInventory()[0]?.manifestCount).toBe(1);
    state.close();
  });
});
