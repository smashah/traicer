import { Schema } from "effect";

export const CANONICAL_TRACE_SCHEMA = "traice.otel-genai.trace/1" as const;
export const MANIFEST_SCHEMA = "traice.manifest/3" as const;
export const OTEL_GENAI_SEMCONV_COMMIT = "b694ec35855d8eccfacd5b09e4b72a808b363038" as const;
export const OTEL_GENAI_SCHEMA_URL = "https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev" as const;
export const OTEL_GENAI_PIPELINE_VERSION = "otel-genai/1" as const;

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
    readonly cacheCreationInputTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens?: number;
  };
}

export interface RedactionReport {
  readonly detectorVersion: "builtin/1";
  readonly profile: string;
  readonly replacements: Readonly<Record<string, number>>;
}

const NonNegativeInteger = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const StructuredValue = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const StructuredValues = Schema.Array(StructuredValue);

export const CanonicalTraceSchema = Schema.Struct({
  schema: Schema.Literal(CANONICAL_TRACE_SCHEMA),
  schemaUrl: Schema.Literal(OTEL_GENAI_SCHEMA_URL),
  semconvCommit: Schema.Literal(OTEL_GENAI_SEMCONV_COMMIT),
  span: Schema.Struct({
    attributes: Schema.Struct({
      "gen_ai.input.messages": Schema.optional(StructuredValues),
      "gen_ai.operation.name": Schema.Literal("chat"),
      "gen_ai.output.messages": Schema.optional(StructuredValues),
      "gen_ai.provider.name": Schema.Literal("anthropic", "openai"),
      "gen_ai.request.frequency_penalty": Schema.optional(Schema.Number),
      "gen_ai.request.max_tokens": Schema.optional(NonNegativeInteger),
      "gen_ai.request.model": Schema.String.pipe(Schema.minLength(1)),
      "gen_ai.request.presence_penalty": Schema.optional(Schema.Number),
      "gen_ai.request.seed": Schema.optional(Schema.Number.pipe(Schema.int())),
      "gen_ai.request.stop_sequences": Schema.optional(Schema.Array(Schema.String)),
      "gen_ai.request.stream": Schema.optional(Schema.Boolean),
      "gen_ai.request.temperature": Schema.optional(Schema.Number),
      "gen_ai.request.top_p": Schema.optional(Schema.Number),
      "gen_ai.response.finish_reasons": Schema.optional(Schema.Array(Schema.String)),
      "gen_ai.response.id": Schema.optional(Schema.String),
      "gen_ai.response.model": Schema.optional(Schema.String.pipe(Schema.minLength(1))),
      "gen_ai.response.status": Schema.optional(Schema.String),
      "gen_ai.system_instructions": Schema.optional(StructuredValues),
      "gen_ai.tool.definitions": Schema.optional(StructuredValues),
      "gen_ai.usage.cache_creation.input_tokens": Schema.optional(NonNegativeInteger),
      "gen_ai.usage.cache_read.input_tokens": Schema.optional(NonNegativeInteger),
      "gen_ai.usage.input_tokens": NonNegativeInteger,
      "gen_ai.usage.output_tokens": NonNegativeInteger,
      "gen_ai.usage.reasoning.output_tokens": Schema.optional(NonNegativeInteger),
      "openai.api.type": Schema.optional(Schema.Literal("chat_completions", "responses")),
    }),
    kind: Schema.Literal("CLIENT"),
    name: Schema.String.pipe(Schema.minLength(1)),
  }),
  traice: Schema.Struct({
    adapter: Schema.String.pipe(Schema.minLength(1)),
    captureRunId: Schema.optional(Schema.UUID),
    capturedAt: Schema.String.pipe(Schema.minLength(1)),
    client: Schema.String.pipe(Schema.minLength(1)),
    pipelineVersion: Schema.String.pipe(Schema.minLength(1)),
    projectScopeId: Schema.optional(Schema.UUID),
    provenance: Schema.Literal("provider_exchange"),
    providerRequest: Schema.Unknown,
    providerResponse: Schema.Struct({
      body: Schema.Unknown,
      statusCode: NonNegativeInteger,
    }),
    redaction: Schema.Struct({
      detectorVersion: Schema.Literal("builtin/1"),
      profile: Schema.String.pipe(Schema.minLength(1)),
      replacements: Schema.Record({ key: Schema.String, value: NonNegativeInteger }),
    }),
    traceId: Schema.String.pipe(Schema.minLength(1)),
  }),
});

export interface GenAiMessagePart extends Readonly<Record<string, unknown>> {
  readonly type: string;
}

export interface GenAiInputMessage extends Readonly<Record<string, unknown>> {
  readonly parts: readonly GenAiMessagePart[];
  readonly role: string;
}

export interface GenAiOutputMessage extends GenAiInputMessage {
  readonly finish_reason: string;
}

export interface GenAiToolDefinition extends Readonly<Record<string, unknown>> {
  readonly name: string;
  readonly type: string;
}

export interface GenAiSpanAttributes {
  readonly "gen_ai.input.messages"?: readonly GenAiInputMessage[];
  readonly "gen_ai.operation.name": "chat";
  readonly "gen_ai.output.messages"?: readonly GenAiOutputMessage[];
  readonly "gen_ai.provider.name": CaptureProvider;
  readonly "gen_ai.request.frequency_penalty"?: number;
  readonly "gen_ai.request.max_tokens"?: number;
  readonly "gen_ai.request.model": string;
  readonly "gen_ai.request.presence_penalty"?: number;
  readonly "gen_ai.request.seed"?: number;
  readonly "gen_ai.request.stop_sequences"?: readonly string[];
  readonly "gen_ai.request.stream"?: boolean;
  readonly "gen_ai.request.temperature"?: number;
  readonly "gen_ai.request.top_p"?: number;
  readonly "gen_ai.response.finish_reasons"?: readonly string[];
  readonly "gen_ai.response.id"?: string;
  readonly "gen_ai.response.model"?: string;
  readonly "gen_ai.response.status"?: string;
  readonly "gen_ai.system_instructions"?: readonly GenAiMessagePart[];
  readonly "gen_ai.tool.definitions"?: readonly GenAiToolDefinition[];
  readonly "gen_ai.usage.cache_creation.input_tokens"?: number;
  readonly "gen_ai.usage.cache_read.input_tokens"?: number;
  readonly "gen_ai.usage.input_tokens": number;
  readonly "gen_ai.usage.output_tokens": number;
  readonly "gen_ai.usage.reasoning.output_tokens"?: number;
  readonly "openai.api.type"?: "chat_completions" | "responses";
}

export interface CanonicalTrace {
  readonly schema: typeof CANONICAL_TRACE_SCHEMA;
  readonly schemaUrl: typeof OTEL_GENAI_SCHEMA_URL;
  readonly semconvCommit: typeof OTEL_GENAI_SEMCONV_COMMIT;
  readonly span: {
    readonly attributes: GenAiSpanAttributes;
    readonly kind: "CLIENT";
    readonly name: string;
  };
  readonly traice: {
    readonly adapter: string;
    readonly captureRunId?: string;
    readonly capturedAt: string;
    readonly client: string;
    readonly pipelineVersion: string;
    readonly projectScopeId?: string;
    readonly provenance: "provider_exchange";
    readonly providerRequest: unknown;
    readonly providerResponse: { readonly body: unknown; readonly statusCode: number };
    readonly redaction: RedactionReport;
    readonly traceId: string;
  };
}

export type StorageIntegrityAssurance = "provider_checksum" | "full_readback";

export interface SafeUploadReceipt {
  readonly encryptedBytes: number;
  readonly integrityAssurance: StorageIntegrityAssurance;
  readonly objectCommitment: string;
  readonly storageCapabilityProfileId: string;
}

export interface SafeManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly adapter: string;
  readonly bucketAlias: string;
  readonly canonicalHash: string;
  readonly canonicalTraceSchema: typeof CANONICAL_TRACE_SCHEMA;
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
  readonly otelSchemaUrl: typeof OTEL_GENAI_SCHEMA_URL;
  readonly otelSemconvCommit: typeof OTEL_GENAI_SEMCONV_COMMIT;
  readonly pipelineVersion: string;
  readonly policyVersion: string;
  readonly provider: CaptureProvider;
  readonly provenance: "provider_exchange";
  readonly projectScopeId?: string;
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
