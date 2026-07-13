import { describe, expect, test } from "bun:test";

import { makeCaptureControl } from "@traice/effect-runtime";

import { createControlApp } from "../src/app";

const token = "test-control-capability-000000000000";

describe("private control API", () => {
  test("rejects requests without the sidecar capability", async () => {
    const app = createControlApp({ control: makeCaptureControl(), controlToken: token, databaseReady: () => true });
    const response = await app.request("http://127.0.0.1/v1/health");
    expect(response.status).toBe(401);
  });

  test("pauses persistence in one authenticated interaction", async () => {
    const app = createControlApp({ control: makeCaptureControl(), controlToken: token, databaseReady: () => true });
    const response = await app.request("http://127.0.0.1/v1/control/pause", {
      body: JSON.stringify({ reason: "privacy", scope: "all" }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ captureStatus: "paused", success: true });
  });
});
