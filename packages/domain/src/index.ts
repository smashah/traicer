export type CaptureStatus = "healthy" | "paused" | "degraded" | "error";

export type TraceState =
  | { readonly state: "observed"; readonly traceId: string }
  | { readonly state: "parsed"; readonly traceId: string }
  | { readonly state: "redacted"; readonly traceId: string; readonly redactionProfile: string }
  | { readonly state: "canonicalised"; readonly traceId: string; readonly canonicalHash: string }
  | { readonly state: "encrypted"; readonly traceId: string; readonly canonicalHash: string; readonly ciphertextHash: string }
  | { readonly state: "quarantined"; readonly traceId: string; readonly reason: "parse_error" | "policy_rejected" | "secret_remaining" }
  | { readonly state: "dropped"; readonly traceId: string; readonly reason: "queue_full" | "unsupported" };

export interface SafeStatus {
  readonly adaptersEnabled: number;
  readonly captureStatus: CaptureStatus;
  readonly committedManifestCount: number;
  readonly protocolVersion: 1;
  readonly queuedTraceCount: number;
}
