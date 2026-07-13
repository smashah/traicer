import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { CaptureControl, CaptureControlTest } from "../src";

describe("CaptureControl", () => {
  test("pauses immediately without exposing a reason in status", async () => {
    const program = Effect.gen(function* () {
      const control = yield* CaptureControl;
      yield* control.pause("privacy");
      return yield* control.status();
    }).pipe(Effect.provide(CaptureControlTest()));

    expect(await Effect.runPromise(program)).toBe("paused");
  });
});
