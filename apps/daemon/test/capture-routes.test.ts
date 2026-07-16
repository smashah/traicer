import { describe, expect, test } from "bun:test";

import { createCaptureRouteRegistry } from "../src/capture-routes";

describe("capture route registry", () => {
  test("issues an opaque token and resolves its immutable capture context", async () => {
    const registry = createCaptureRouteRegistry({
      now: () => 1_000,
      randomBytes: () => new Uint8Array(32).fill(7),
      randomUuid: () => "99999999-9999-4999-8999-999999999999",
    });
    const issued = await registry.issue({
      captureRunId: "22222222-2222-4222-8222-222222222222",
      client: "claude-code",
      projectScopeId: "33333333-3333-4333-8333-333333333333",
      providers: ["anthropic"],
      routeId: "11111111-1111-4111-8111-111111111111",
      ttlSeconds: 600,
    });

    expect(issued.routeId).toBe("11111111-1111-4111-8111-111111111111");
    expect(issued.routeToken).toHaveLength(43);
    expect(await registry.resolve(issued.routeToken)).toEqual({
      captureRunId: "22222222-2222-4222-8222-222222222222",
      client: "claude-code",
      expiresAt: "1970-01-01T00:10:01.000Z",
      projectScopeId: "33333333-3333-4333-8333-333333333333",
      providers: ["anthropic"],
      routeId: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("revokes routes without retaining or returning the plaintext token", async () => {
    const registry = createCaptureRouteRegistry();
    const issued = await registry.issue({
      captureRunId: crypto.randomUUID(),
      client: "codex",
      projectScopeId: crypto.randomUUID(),
      providers: ["openai"],
      ttlSeconds: 600,
    });
    expect(await registry.revoke(issued.routeId)).toBe(true);
    expect(await registry.resolve(issued.routeToken)).toBeUndefined();
    expect(await registry.revoke(issued.routeId)).toBe(false);
  });

  test("expires routes and validates their bounded inputs", async () => {
    let now = 5_000;
    const registry = createCaptureRouteRegistry({ now: () => now });
    const issued = await registry.issue({
      captureRunId: crypto.randomUUID(),
      client: "opencode",
      projectScopeId: crypto.randomUUID(),
      providers: ["anthropic", "openai"],
      ttlSeconds: 60,
    });
    now += 60_001;
    expect(await registry.resolve(issued.routeToken)).toBeUndefined();

    await expect(registry.issue({
      captureRunId: "invalid",
      client: "opencode",
      projectScopeId: crypto.randomUUID(),
      providers: ["openai"],
      ttlSeconds: 60,
    })).rejects.toThrow("capture run ID");
  });
});
