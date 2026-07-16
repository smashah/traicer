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

  test("issues and revokes a project-scoped capture route", async () => {
    const issued: unknown[] = [];
    const revoked: string[] = [];
    const app = createControlApp({
      control: makeCaptureControl(),
      controlToken: token,
      databaseReady: () => true,
      issueCaptureRoute: async (input) => {
        issued.push(input);
        return {
          expiresAt: "2030-01-01T00:00:00.000Z",
          routeId: "11111111-1111-4111-8111-111111111111",
          routeToken: "route-capability-that-must-not-be-logged",
        };
      },
      revokeCaptureRoute: async (routeId) => {
        revoked.push(routeId);
        return true;
      },
    });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const response = await app.request("http://127.0.0.1/v1/capture-routes", {
      body: JSON.stringify({
        captureRunId: "22222222-2222-4222-8222-222222222222",
        client: "claude-code",
        projectScopeId: "33333333-3333-4333-8333-333333333333",
        providers: ["anthropic"],
        ttlSeconds: 600,
      }),
      headers,
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        expiresAt: "2030-01-01T00:00:00.000Z",
        routeId: "11111111-1111-4111-8111-111111111111",
        routeToken: "route-capability-that-must-not-be-logged",
      },
      success: true,
    });
    expect(issued).toHaveLength(1);

    const revoke = await app.request(
      "http://127.0.0.1/v1/capture-routes/11111111-1111-4111-8111-111111111111",
      { headers, method: "DELETE" }
    );
    expect(await revoke.json()).toEqual({ revoked: true, success: true });
    expect(revoked).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  test("returns content-free status, trace metadata and diagnostics", async () => {
    const app = createControlApp({
      control: makeCaptureControl(),
      controlToken: token,
      databaseReady: () => true,
      queueCounts: () => ({ committed: 4, pending: 2 }),
      traces: () => [{
        capturedAt: "2026-07-13T18:00:00.000Z",
        state: "committed",
        traceId: "safe-trace-id",
        updatedAt: "2026-07-13T18:00:01.000Z",
      }],
    });
    const authenticated = { authorization: `Bearer ${token}` };
    const status = await app.request("http://127.0.0.1/v1/status", { headers: authenticated });
    expect(await status.json()).toMatchObject({
      committedManifestCount: 4,
      queuedTraceCount: 2,
    });
    const traces = await app.request("http://127.0.0.1/v1/traces", { headers: authenticated });
    expect(await traces.json()).toEqual({ traces: [{
      capturedAt: "2026-07-13T18:00:00.000Z",
      state: "committed",
      traceId: "safe-trace-id",
      updatedAt: "2026-07-13T18:00:01.000Z",
    }] });
    const diagnostics = await app.request("http://127.0.0.1/v1/diagnostics/export", {
      headers: authenticated,
      method: "POST",
    });
    const body = await diagnostics.text();
    expect(body).toContain('"contentIncluded":false');
    expect(body).not.toContain("sk-test-raw-canary-never-egress");
  });

  test("requires a reason and invokes trace deletion", async () => {
    const deleted: string[] = [];
    const app = createControlApp({
      control: makeCaptureControl(),
      controlToken: token,
      databaseReady: () => true,
      deleteTrace: async (traceId, reason) => {
        deleted.push(`${traceId}:${reason}`);
        return { id: "manifest-1", status: "deleted" };
      },
    });
    const response = await app.request("http://127.0.0.1/v1/traces/trace-1/delete", {
      body: JSON.stringify({ reason: "Seller requested permanent deletion" }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(deleted).toEqual(["trace-1:Seller requested permanent deletion"]);
  });
});
