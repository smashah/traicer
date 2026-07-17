import { describe, expect, test } from "bun:test";

import {
  createServiceClient,
  formatInstructions,
  formatServiceStatus,
} from "../src/service-commands";

describe("CLI daemon discovery commands", () => {
  test("reports safe health and loopback endpoints without capabilities", async () => {
    const requests: string[] = [];
    const client = createServiceClient({
      connection: {
        controlBaseUrl: "http://127.0.0.1:41001",
        gatewayBaseUrl: "http://127.0.0.1:41002",
        instanceId: "instance-1",
        pid: 123,
        protocolVersion: 2,
      },
      controlToken: "control-secret",
      fetcher: async (input) => {
        requests.push(String(input));
        return Response.json({
          captureStatus: "healthy",
          database: "ready",
          gateway: "ready",
          manifests: { committed: 4, pending: 2 },
          marketplace: "disconnected",
          storage: "ready",
        });
      },
    });
    const status = await client.status();
    expect(status).toMatchObject({
      captureStatus: "healthy",
      marketplace: "disconnected",
      pendingManifests: 2,
      pid: 123,
      running: true,
      storage: "ready",
    });
    expect(formatServiceStatus(status)).toContain("Marketplace: account not connected");
    expect(formatServiceStatus(status)).toContain("Seller storage: ready");
    expect(formatServiceStatus(status)).not.toContain("control-secret");
    expect(requests).toEqual(["http://127.0.0.1:41001/v1/health"]);
  });

  test("issues one short-lived project-scoped route only when URLs are explicitly revealed", async () => {
    const bodies: unknown[] = [];
    const client = createServiceClient({
      connection: {
        controlBaseUrl: "http://127.0.0.1:41001",
        gatewayBaseUrl: "http://127.0.0.1:41002",
        instanceId: "instance-1",
      },
      controlToken: "control-secret",
      fetcher: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ data: {
          expiresAt: "2026-07-17T20:00:00.000Z",
          routeId: "11111111-1111-4111-8111-111111111111",
          routeToken: "route-capability",
        } });
      },
    });
    expect(await client.urls("22222222-2222-4222-8222-222222222222")).toEqual({
      anthropic: "http://127.0.0.1:41002/anthropic/route-capability",
      expiresAt: "2026-07-17T20:00:00.000Z",
      openai: "http://127.0.0.1:41002/openai/route-capability/v1",
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      client: "opencode",
      projectScopeId: "22222222-2222-4222-8222-222222222222",
      providers: ["anthropic", "openai"],
      ttlSeconds: 43_200,
    });
  });

  test("gives copy-ready harness instructions without persisting or printing a route token", () => {
    const output = formatInstructions();
    expect(output).toContain("traicer run -- claude");
    expect(output).toContain("traicer run -- codex");
    expect(output).toContain("traicer run -- opencode");
    expect(output).toContain("traicer urls --reveal");
  });
});
