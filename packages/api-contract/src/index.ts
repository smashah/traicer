import { Schema } from "effect";

export const CaptureBootstrapV1 = Schema.Struct({
  adapterCapability: Schema.String.pipe(Schema.minLength(16)),
  bucketAlias: Schema.String.pipe(Schema.minLength(1)),
  client: Schema.String.pipe(Schema.minLength(1)),
  deviceId: Schema.String.pipe(Schema.minLength(1)),
  marketplace: Schema.Struct({
    apiBaseUrl: Schema.String.pipe(Schema.minLength(1)),
    credential: Schema.String.pipe(Schema.minLength(1)),
  }),
  policy: Schema.Struct({
    allowedPaths: Schema.Array(Schema.String),
    capturePolicyId: Schema.String.pipe(Schema.minLength(1)),
    pipelineVersion: Schema.String.pipe(Schema.minLength(1)),
    policyVersion: Schema.String.pipe(Schema.minLength(1)),
    redactionProfile: Schema.String.pipe(Schema.minLength(1)),
  }),
  signerKeyId: Schema.String.pipe(Schema.minLength(1)),
  signingPrivateKey: Schema.String.pipe(Schema.minLength(1)),
  storage: Schema.Struct({
    accessKeyId: Schema.String.pipe(Schema.minLength(1)),
    addressingStyle: Schema.Literal("path", "virtual_hosted"),
    bucket: Schema.String.pipe(Schema.minLength(1)),
    endpoint: Schema.String.pipe(Schema.minLength(1)),
    prefix: Schema.String,
    secretAccessKey: Schema.String.pipe(Schema.minLength(1)),
    sessionToken: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
    signingRegion: Schema.String.pipe(Schema.minLength(1)),
    storageCapabilityProfileId: Schema.String.pipe(Schema.minLength(1)),
  }),
  upstreamOrigin: Schema.String.pipe(Schema.minLength(1)),
});

export const BootstrapV1 = Schema.Struct({
  capture: Schema.optional(CaptureBootstrapV1),
  controlToken: Schema.String.pipe(Schema.minLength(32)),
  protocolVersion: Schema.Literal(1),
  vaultKey: Schema.String.pipe(Schema.minLength(43)),
});

export const SafeHealthV1 = Schema.Struct({
  captureStatus: Schema.Literal("healthy", "paused", "degraded", "error"),
  database: Schema.Literal("ready", "error"),
  gateway: Schema.Literal("not_started", "ready", "paused"),
  protocolVersion: Schema.Literal(1),
  spool: Schema.Literal("ready", "paused", "error"),
});

export const PauseRequestV1 = Schema.Struct({
  reason: Schema.Literal("user", "privacy", "maintenance"),
  scope: Schema.Literal("all"),
});

export type BootstrapV1 = typeof BootstrapV1.Type;
export type CaptureBootstrapV1 = typeof CaptureBootstrapV1.Type;
export type PauseRequestV1 = typeof PauseRequestV1.Type;
