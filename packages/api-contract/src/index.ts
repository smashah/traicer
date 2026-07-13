import { Schema } from "effect";

export const BootstrapV1 = Schema.Struct({
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
export type PauseRequestV1 = typeof PauseRequestV1.Type;
