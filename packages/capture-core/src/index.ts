import {
  encryptTraceEnvelope,
  sha256Hex,
  signBytes,
} from "@traice/crypto";
import {
  CANONICAL_TRACE_SCHEMA,
  MANIFEST_SCHEMA,
  OTEL_GENAI_SEMCONV_COMMIT,
  OTEL_GENAI_SCHEMA_URL,
  type CaptureOutcome,
  type CapturePolicyV1,
  type ObservedProviderExchange,
  type SafeManifest,
  type SafeUploadReceipt,
  type SignedSafeManifest,
} from "@traice/domain";
import {
  canonicalBytes,
  canonicalJson,
  redactExchange,
  stripTransportSecrets,
} from "@traice/privacy-pipeline";

export const sanitizeTransportHeaders = stripTransportSecrets;

export interface SellerObjectStore {
  readonly putEnvelope: (input: {
    readonly bytes: Uint8Array;
    readonly ciphertextHash: string;
  }) => Promise<SafeUploadReceipt>;
}

export interface MarketplaceManifestSink {
  readonly submit: (input: {
    readonly idempotencyKey: string;
    readonly manifests: readonly SignedSafeManifest[];
  }) => Promise<void>;
}

export interface CaptureEngineConfig {
  readonly bucketAlias: string;
  readonly deviceId: string;
  readonly policy: CapturePolicyV1;
  readonly signerKeyId: string;
  readonly signingPrivateKey: string;
  readonly wrappingKey: Uint8Array;
}

export interface CaptureEngineHooks {
  readonly committed?: (input: {
    readonly clientManifestId: string;
    readonly traceId: string;
  }) => void;
  readonly encrypted?: (input: {
    readonly canonicalHash: string;
    readonly ciphertextHash: string;
    readonly traceId: string;
  }) => void;
  readonly failed?: (input: {
    readonly code: "capture_failed";
    readonly stage: "privacy" | "encryption" | "storage" | "manifest";
    readonly traceId: string;
  }) => void;
  readonly manifestPending?: (input: {
    readonly clientManifestId: string;
    readonly traceId: string;
  }) => void;
  readonly observed?: (input: {
    readonly captureRunId?: string;
    readonly capturedAt: string;
    readonly client: string;
    readonly projectScopeId?: string;
    readonly provider: ObservedProviderExchange["provider"];
    readonly traceId: string;
  }) => void;
}

const coarseHour = (value: string): string => {
  const date = new Date(value);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
};

const countToolCalls = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countToolCalls(item), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Readonly<Record<string, unknown>>;
  return (record.type === "tool_call" ? 1 : 0)
    + Object.values(record).reduce<number>((total, item) => total + countToolCalls(item), 0);
};

export const createCaptureEngine = (
  config: CaptureEngineConfig,
  objectStore: SellerObjectStore,
  manifestSink: MarketplaceManifestSink,
  hooks: CaptureEngineHooks = {}
) => ({
  capture: async (observed: ObservedProviderExchange): Promise<CaptureOutcome> => {
    let stage: "privacy" | "encryption" | "storage" | "manifest" = "privacy";
    try {
      const { report, trace } = redactExchange(observed, config.policy);
      hooks.observed?.({
        ...(observed.captureRunId ? { captureRunId: observed.captureRunId } : {}),
        capturedAt: observed.capturedAt,
        client: observed.client,
        ...(observed.projectScopeId ? { projectScopeId: observed.projectScopeId } : {}),
        provider: observed.provider,
        traceId: observed.traceId,
      });
      const plaintext = canonicalBytes(trace);
      stage = "encryption";
      const encrypted = await encryptTraceEnvelope({
        canonicalBytes: plaintext,
        traceId: observed.traceId,
        wrappingKey: config.wrappingKey,
      });
      stage = "storage";
      const receipt = await objectStore.putEnvelope({
        bytes: encrypted.bytes,
        ciphertextHash: encrypted.ciphertextHash,
      });
      if (receipt.encryptedBytes !== encrypted.bytes.byteLength) {
        throw new Error("Seller storage byte count did not reconcile");
      }
      hooks.encrypted?.({
        canonicalHash: encrypted.canonicalHash,
        ciphertextHash: encrypted.ciphertextHash,
        traceId: observed.traceId,
      });

      const manifest = {
      adapter: observed.adapter,
      bucketAlias: config.bucketAlias,
      canonicalHash: encrypted.canonicalHash,
      canonicalTraceSchema: CANONICAL_TRACE_SCHEMA,
      capturePolicyId: config.policy.capturePolicyId,
      capturedAt: coarseHour(observed.capturedAt),
      ciphertextHash: encrypted.ciphertextHash,
      client: observed.client,
      clientManifestId: crypto.randomUUID(),
      deviceId: config.deviceId,
      encryptedBytes: encrypted.bytes.byteLength,
      inputTokens: observed.usage.inputTokens,
      model: observed.model,
      objectLocatorCommitment: receipt.objectCommitment,
      outputTokens: observed.usage.outputTokens,
      otelSchemaUrl: OTEL_GENAI_SCHEMA_URL,
      otelSemconvCommit: OTEL_GENAI_SEMCONV_COMMIT,
      pipelineVersion: config.policy.pipelineVersion,
      policyVersion: config.policy.policyVersion,
      provider: observed.provider,
      provenance: trace.traice.provenance,
      redaction: {
        detectorVersion: report.detectorVersion,
        profile: report.profile,
        replacementCounts: report.replacements,
      },
      ...(trace.traice.projectScopeId === undefined
        ? {}
        : { projectScopeId: trace.traice.projectScopeId }),
      schema: MANIFEST_SCHEMA,
      signerKeyId: config.signerKeyId,
      storageCapabilityProfileId: receipt.storageCapabilityProfileId,
      storageIntegrityAssurance: receipt.integrityAssurance,
      storageKind: "s3_compatible",
      toolCallCount: countToolCalls(trace),
      verificationTier: "self_attested",
      } satisfies SafeManifest;
      const signature = await signBytes(
        config.signingPrivateKey,
        canonicalBytes(manifest)
      );
      const signedManifest = { manifest, signature } satisfies SignedSafeManifest;
      hooks.manifestPending?.({
        clientManifestId: manifest.clientManifestId,
        traceId: observed.traceId,
      });
      stage = "manifest";
      await manifestSink.submit({
        idempotencyKey: `manifest:${manifest.clientManifestId}`,
        manifests: [signedManifest],
      });
      hooks.committed?.({
        clientManifestId: manifest.clientManifestId,
        traceId: observed.traceId,
      });
      return {
        canonicalHash: encrypted.canonicalHash,
        ciphertextHash: encrypted.ciphertextHash,
        manifest: signedManifest,
        traceId: observed.traceId,
      };
    } catch (error) {
      hooks.failed?.({ code: "capture_failed", stage, traceId: observed.traceId });
      throw error;
    }
  },
  fingerprintConfig: async (): Promise<string> =>
    sha256Hex(
      canonicalJson({
        bucketAlias: config.bucketAlias,
        deviceId: config.deviceId,
        policy: config.policy,
        signerKeyId: config.signerKeyId,
      })
    ),
});
