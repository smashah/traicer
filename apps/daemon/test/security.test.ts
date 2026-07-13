import { describe, expect, test } from "bun:test";

import { createControlApp } from "../src/app";
import { makeCaptureControl } from "@traice/effect-runtime";

describe("control egress safety", () => {
  test("health contains operational state only", async () => {
    const token = "test-control-capability-000000000000";
    const app = createControlApp({ control: makeCaptureControl(), controlToken: token, databaseReady: () => true });
    const response = await app.request("http://127.0.0.1/v1/health", {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/authorization|credential|prompt|response|traceBody/i);
  });
});
