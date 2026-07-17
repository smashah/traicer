import { describe, expect, test } from "bun:test";

import { waitForDaemonReady, waitForDaemonStop } from "../src/lifecycle";

describe("detached daemon lifecycle", () => {
  test("waits for the structured readiness line without copying bootstrap secrets", async () => {
    const stream = new Blob([
      `${JSON.stringify({ controlPort: 41001, gatewayPort: 41002, pid: 123, protocolVersion: 2, type: "ready" })}\n`,
    ]).stream();
    expect(await waitForDaemonReady(stream, 1_000)).toEqual({
      controlPort: 41001,
      gatewayPort: 41002,
      pid: 123,
      protocolVersion: 2,
    });
  });

  test("polls bounded authenticated discovery until the daemon is gone", async () => {
    let attempts = 0;
    await waitForDaemonStop(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("still running");
      return true;
    }, 1_000, 1);
    expect(attempts).toBe(3);
  });
});
