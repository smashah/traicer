import { Schema } from "effect";
import { Hono } from "hono";
import { Effect } from "effect";

import { PauseRequestV1 } from "@traice/api-contract";
import { constantTimeEqual } from "@traice/crypto";
import type { CaptureControlShape } from "@traice/effect-runtime";

export interface ControlDependencies {
  readonly control: CaptureControlShape;
  readonly controlToken: string;
  readonly databaseReady: () => boolean;
  readonly gatewayReady?: () => boolean;
  readonly onPause?: () => void;
  readonly onResume?: () => void;
  readonly queueCounts?: () => { readonly committed: number; readonly pending: number };
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
      protocolVersion: 1,
      spool: captureStatus === "paused" ? "paused" : "ready",
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
