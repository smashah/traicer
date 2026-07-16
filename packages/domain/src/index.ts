export type CaptureStatus = "healthy" | "paused" | "degraded" | "error";

export type CaptureProvider = "anthropic" | "openai";

export type TraceState =
  | { readonly state: "observed"; readonly traceId: string }
  | { readonly state: "parsed"; readonly traceId: string }
  | {
      readonly state: "redacted";
      readonly traceId: string;
      readonly redactionProfile: string;
    }
  | {
      readonly state: "canonicalised";
      readonly traceId: string;
      readonly canonicalHash: string;
    }
  | {
      readonly state: "encrypted";
      readonly traceId: string;
      readonly canonicalHash: string;
      readonly ciphertextHash: string;
    }
  | {
      readonly state: "quarantined";
      readonly traceId: string;
      readonly reason: "parse_error" | "policy_rejected" | "secret_remaining";
    }
  | {
      readonly state: "dropped";
      readonly traceId: string;
      readonly reason: "queue_full" | "unsupported";
    };

export interface SafeStatus {
  readonly adaptersEnabled: number;
  readonly captureStatus: CaptureStatus;
  readonly committedManifestCount: number;
  readonly protocolVersion: 1;
  readonly queuedTraceCount: number;
}

export interface CapturePolicyV1 {
  readonly schema: "traice.capture-policy/1";
  readonly capturePolicyId: string;
  readonly policyVersion: string;
  readonly pipelineVersion: string;
  readonly redactionProfile: string;
  readonly allowedMethods: readonly ["POST"];
  readonly allowedPaths: readonly string[];
  readonly successfulResponsesOnly: boolean;
}

export interface ObservedProviderExchange {
  readonly adapter: string;
  readonly captureRunId?: string;
  readonly capturedAt: string;
  readonly client: string;
  readonly method: "POST";
  readonly model: string;
  readonly path: string;
  readonly provider: CaptureProvider;
  readonly projectScopeId?: string;
  readonly requestBody: unknown;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseBody: unknown;
  readonly responseStatus: number;
  readonly traceId: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface RedactionReport {
  readonly detectorVersion: "builtin/1";
  readonly profile: string;
  readonly replacements: Readonly<Record<string, number>>;
}

export interface CanonicalTraceV1 {
  readonly schema: "traice.trace/1";
  readonly adapter: string;
  readonly capturedAt: string;
  readonly client: string;
  readonly model: string;
  readonly provider: CaptureProvider;
  readonly redaction: RedactionReport;
  readonly request: unknown;
  readonly response: {
    readonly body: unknown;
    readonly status: number;
  };
  readonly traceId: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface CanonicalTraceV2 extends Omit<CanonicalTraceV1, "schema"> {
  readonly schema: "traice.trace/2";
  readonly captureRunId: string;
  readonly projectScopeId: string;
}

export type CanonicalTrace = CanonicalTraceV1 | CanonicalTraceV2;

export type StorageIntegrityAssurance = "provider_checksum" | "full_readback";

export interface SafeUploadReceipt {
  readonly encryptedBytes: number;
  readonly integrityAssurance: StorageIntegrityAssurance;
  readonly objectCommitment: string;
  readonly storageCapabilityProfileId: string;
}

export interface SafeManifestV1 {
  readonly schema: "traice.manifest/1";
  readonly adapter: string;
  readonly bucketAlias: string;
  readonly canonicalHash: string;
  readonly capturePolicyId: string;
  readonly capturedAt: string;
  readonly ciphertextHash: string;
  readonly client: string;
  readonly clientManifestId: string;
  readonly deviceId: string;
  readonly encryptedBytes: number;
  readonly inputTokens: number;
  readonly model: string;
  readonly objectLocatorCommitment: string;
  readonly outputTokens: number;
  readonly pipelineVersion: string;
  readonly policyVersion: string;
  readonly provider: CaptureProvider;
  readonly redaction: {
    readonly detectorVersion: string;
    readonly profile: string;
    readonly replacementCounts: Readonly<Record<string, number>>;
  };
  readonly signerKeyId: string;
  readonly storageCapabilityProfileId: string;
  readonly storageIntegrityAssurance: StorageIntegrityAssurance;
  readonly storageKind: "s3_compatible";
  readonly toolCallCount: number;
  readonly verificationTier: "self_attested";
}

export interface SafeManifestV2 extends Omit<SafeManifestV1, "schema"> {
  readonly schema: "traice.manifest/2";
  readonly projectScopeId: string;
}

export type SafeManifest = SafeManifestV1 | SafeManifestV2;

export interface SignedSafeManifest {
  readonly manifest: SafeManifest;
  readonly signature: string;
}

export interface CaptureOutcome {
  readonly canonicalHash: string;
  readonly ciphertextHash: string;
  readonly manifest: SignedSafeManifest;
  readonly traceId: string;
}
