import type { CaptureStatus } from "@traice/domain";
import { Context, Effect, Layer } from "effect";

export interface CaptureControlShape {
  readonly pause: (reason: "user" | "privacy" | "maintenance") => Effect.Effect<CaptureStatus>;
  readonly resume: () => Effect.Effect<CaptureStatus>;
  readonly status: () => Effect.Effect<CaptureStatus>;
}

export const CaptureControl = Context.GenericTag<CaptureControlShape>(
  "@traice/CaptureControl"
);

export const makeCaptureControl = (initial: CaptureStatus = "healthy"): CaptureControlShape => {
  let current = initial;
  return {
    pause: () => Effect.sync(() => (current = "paused")),
    resume: () => Effect.sync(() => (current = "healthy")),
    status: () => Effect.sync(() => current),
  };
};

export const CaptureControlLive = Layer.succeed(
  CaptureControl,
  makeCaptureControl()
);

export const CaptureControlTest = (initial: CaptureStatus = "healthy") =>
  Layer.succeed(CaptureControl, makeCaptureControl(initial));
