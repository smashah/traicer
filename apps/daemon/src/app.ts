import { Schema } from "effect";
import { Hono } from "hono";
import { Effect } from "effect";
import { streamSSE } from "hono/streaming";

import { PauseRequestV1 } from "@traice/api-contract";
import { constantTimeEqual } from "@traice/crypto";
import type { CaptureControlShape } from "@traice/effect-runtime";

import type { CaptureRouteInput } from "./capture-routes";

export interface ControlDependencies {
  readonly abortMultipart?: (ciphertextHash: string) => Promise<boolean>;
  readonly control: CaptureControlShape;
  readonly controlToken: string;
  readonly databaseReady: () => boolean;
  readonly commitDataset?: (requestId: string) => Promise<unknown>;
  readonly gatewayReady?: () => boolean;
  readonly issueCaptureRoute?: (input: CaptureRouteInput) => Promise<{
    readonly expiresAt: string;
    readonly routeId: string;
    readonly routeToken: string;
  }>;
  readonly instanceId?: string;
  readonly onPause?: () => void;
  readonly onResume?: () => void;
  readonly proposeAgreement?: (requestId: string) => Promise<unknown>;
  readonly prepareDelivery?: (requestId: string) => Promise<unknown>;
  readonly protocolVersion?: 1 | 2;
  readonly revokeCaptureRoute?: (routeId: string) => Promise<boolean>;
  readonly queueCounts?: () => { readonly committed: number; readonly pending: number };
  readonly eventsAfter?: (sequence: number) => readonly {
    readonly createdAt: string;
    readonly details: Readonly<Record<string, boolean | number | string>>;
    readonly kind: string;
    readonly sequence: number;
  }[];
  readonly deleteTrace?: (traceId: string, reason: string) => Promise<unknown>;
  readonly traces?: (limit: number, offset: number) => readonly {
    readonly capturedAt: string;
    readonly state: string;
    readonly traceId: string;
    readonly updatedAt: string;
  }[];
  readonly workQueue?: () => Promise<readonly unknown[]>;
}

export const createControlApp = (dependencies: ControlDependencies) => {
  const app = new Hono();

  app.use("/v1/*", async (context, next) => {
    const host = new URL(context.req.url).hostname;
    const bearer = context.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!(host === "127.0.0.1" || host === "localhost" || host === "[::1]")) {
      return context.json({ code: "LOOPBACK_REQUIRED", message: "Loopback access is required" }, 403);
    }
    if (!constantTimeEqual(bearer, dependencies.controlToken)) {
      return context.json({ code: "UNAUTHENTICATED", message: "Control capability required" }, 401);
    }
    return next();
  });

  app.get("/v1/health", async (context) => {
    const captureStatus = await Effect.runPromise(dependencies.control.status());
    return context.json({
      captureStatus,
      database: dependencies.databaseReady() ? "ready" : "error",
      gateway: dependencies.gatewayReady?.()
        ? captureStatus === "paused"
          ? "paused"
          : "ready"
        : "not_started",
      manifests: dependencies.queueCounts?.() ?? { committed: 0, pending: 0 },
      instanceId: dependencies.instanceId,
      protocolVersion: dependencies.protocolVersion ?? 1,
      spool: captureStatus === "paused" ? "paused" : "ready",
    });
  });

  app.get("/v1/status", async (context) => {
    const captureStatus = await Effect.runPromise(dependencies.control.status());
    return context.json({
      adaptersEnabled: dependencies.gatewayReady?.() ? 1 : 0,
      captureStatus,
      committedManifestCount: dependencies.queueCounts?.().committed ?? 0,
      protocolVersion: dependencies.protocolVersion ?? 1,
      queuedTraceCount: dependencies.queueCounts?.().pending ?? 0,
    });
  });

  app.get("/v1/adapters", (context) =>
    context.json({
      adapters: dependencies.gatewayReady?.()
        ? [{ compatibility: "declared", id: "active-provider", state: "enabled", visibility: "gateway" }]
        : [],
    })
  );

  app.post("/v1/capture-routes", async (context) => {
    if (!dependencies.issueCaptureRoute) {
      return context.json({ code: "CAPTURE_NOT_CONFIGURED", message: "Capture is not configured" }, 409);
    }
    try {
      const route = await dependencies.issueCaptureRoute(await context.req.json<CaptureRouteInput>());
      return context.json({ data: route, success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid capture route";
      return context.json({ code: "INVALID_REQUEST", message }, 400);
    }
  });

  app.delete("/v1/capture-routes/:id", async (context) => {
    if (!dependencies.revokeCaptureRoute) {
      return context.json({ code: "CAPTURE_NOT_CONFIGURED", message: "Capture is not configured" }, 409);
    }
    const routeId = context.req.param("id");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(routeId)) {
      return context.json({ code: "INVALID_REQUEST", message: "A route UUID is required" }, 400);
    }
    return context.json({ revoked: await dependencies.revokeCaptureRoute(routeId), success: true });
  });

  app.get("/v1/storage/status", (context) =>
    context.json({
      databaseReady: dependencies.databaseReady(),
      manifestQueue: dependencies.queueCounts?.() ?? { committed: 0, pending: 0 },
      spool: "encrypted_only",
    })
  );

  app.post("/v1/storage/multipart/:hash/abort", async (context) => {
    if (!dependencies.abortMultipart) {
      return context.json({ code: "CAPTURE_NOT_CONFIGURED", message: "Capture is not configured" }, 409);
    }
    const ciphertextHash = context.req.param("hash");
    if (!/^[a-f0-9]{64}$/.test(ciphertextHash)) {
      return context.json({ code: "INVALID_REQUEST", message: "A lowercase SHA-256 hash is required" }, 400);
    }
    return context.json({ aborted: await dependencies.abortMultipart(ciphertextHash), success: true });
  });

  app.get("/v1/traces", (context) => {
    const limit = Number.parseInt(context.req.query("limit") ?? "50", 10);
    const offset = Number.parseInt(context.req.query("offset") ?? "0", 10);
    return context.json({ traces: dependencies.traces?.(limit, offset) ?? [] });
  });

  app.post("/v1/traces/:id/delete", async (context) => {
    if (!dependencies.deleteTrace) {
      return context.json({ code: "CAPTURE_NOT_CONFIGURED", message: "Capture is not configured" }, 409);
    }
    const traceId = context.req.param("id");
    const input = await context.req.json<{ reason?: unknown }>();
    if (typeof input.reason !== "string" || input.reason.trim().length < 8 || input.reason.length > 500) {
      return context.json({ code: "INVALID_REQUEST", message: "A deletion reason is required" }, 400);
    }
    try {
      return context.json({ data: await dependencies.deleteTrace(traceId, input.reason.trim()), success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Trace deletion failed";
      return context.json({ code: "TRACE_DELETE_FAILED", message }, 409);
    }
  });

  app.get("/v1/redaction/profiles", (context) =>
    context.json({
      detectorVersion: "builtin/1",
      profiles: [{ id: "strict-default", state: "active" }],
    })
  );

  app.get("/v1/work", async (context) =>
    context.json({ items: await dependencies.workQueue?.() ?? [] })
  );

  app.post("/v1/datasets/commit", async (context) => {
    if (!dependencies.commitDataset) {
      return context.json({ code: "CAPTURE_NOT_CONFIGURED", message: "Capture is not configured" }, 409);
    }
    const input = await context.req.json<{ requestId?: unknown }>();
    if (typeof input.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.requestId)) {
      return context.json({ code: "INVALID_REQUEST", message: "A request UUID is required" }, 400);
    }
    return context.json({ data: await dependencies.commitDataset(input.requestId), success: true });
  });

  app.post("/v1/agreements/propose", async (context) => {
    if (!dependencies.proposeAgreement) {
      return context.json({ code: "CAPTURE_NOT_CONFIGURED", message: "Capture is not configured" }, 409);
    }
    const input = await context.req.json<{ requestId?: unknown }>();
    if (typeof input.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.requestId)) {
      return context.json({ code: "INVALID_REQUEST", message: "A request UUID is required" }, 400);
    }
    return context.json({ data: await dependencies.proposeAgreement(input.requestId), success: true });
  });

  app.post("/v1/deliveries/prepare", async (context) => {
    if (!dependencies.prepareDelivery) {
      return context.json({ code: "CAPTURE_NOT_CONFIGURED", message: "Capture is not configured" }, 409);
    }
    const input = await context.req.json<{ requestId?: unknown }>();
    if (typeof input.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.requestId)) {
      return context.json({ code: "INVALID_REQUEST", message: "A request UUID is required" }, 400);
    }
    return context.json({ data: await dependencies.prepareDelivery(input.requestId), success: true });
  });

  app.get("/v1/events", (context) => {
    const after = Number.parseInt(context.req.header("last-event-id") ?? "0", 10);
    return streamSSE(context, async (stream) => {
      let sequence = Number.isFinite(after) ? after : 0;
      const deadline = Date.now() + 25_000;
      while (!stream.aborted && Date.now() < deadline) {
        const events = dependencies.eventsAfter?.(sequence) ?? [];
        for (const event of events) {
          sequence = event.sequence;
          await stream.writeSSE({
            data: JSON.stringify({ createdAt: event.createdAt, details: event.details }),
            event: event.kind,
            id: String(event.sequence),
          });
        }
        await stream.sleep(events.length > 0 ? 250 : 1_000);
      }
    });
  });

  app.post("/v1/diagnostics/export", async (context) => {
    const captureStatus = await Effect.runPromise(dependencies.control.status());
    return context.json({
      generatedAt: new Date().toISOString(),
      privacy: { contentIncluded: false, credentialsIncluded: false, pathsIncluded: false },
      schema: "traice.diagnostics/1",
      status: {
        captureStatus,
        databaseReady: dependencies.databaseReady(),
        gatewayReady: dependencies.gatewayReady?.() ?? false,
        manifests: dependencies.queueCounts?.() ?? { committed: 0, pending: 0 },
      },
      versions: {
        canonicalTrace: 1,
        database: 1,
        detector: "builtin/1",
        envelope: 1,
        protocol: dependencies.protocolVersion ?? 1,
      },
    });
  });

  app.post("/v1/control/pause", async (context) => {
    const input = Schema.decodeUnknownSync(PauseRequestV1)(await context.req.json());
    const captureStatus = await Effect.runPromise(dependencies.control.pause(input.reason));
    dependencies.onPause?.();
    return context.json({ captureStatus, success: true });
  });

  app.post("/v1/control/resume", async (context) => {
    const captureStatus = await Effect.runPromise(dependencies.control.resume());
    dependencies.onResume?.();
    return context.json({ captureStatus, success: true });
  });

  return app;
};
