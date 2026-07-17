import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  locateDaemon,
  removeUnreachableRuntimeDescriptor,
  runtimeDescriptorExists,
} from "../src/daemon-locator";

describe("daemon discovery", () => {
  test("verifies the secret-free descriptor against authenticated health", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traicer-daemon-locator-"));
    const instanceId = "11111111-1111-4111-8111-111111111111";
    await Bun.write(join(directory, ".runtime.json"), JSON.stringify({
      controlPort: 41001,
      gatewayPort: 41002,
      instanceId,
      pid: 123,
      proxyPort: 41003,
      protocolVersion: 2,
      schema: "traicer.runtime/1",
    }));
    const authorizations: string[] = [];
    const located = await locateDaemon(directory, "control-secret", async (input, init) => {
      authorizations.push(new Request(input, init).headers.get("authorization") ?? "");
      return Response.json({ instanceId });
    });
    expect(located).toEqual({
      controlBaseUrl: "http://127.0.0.1:41001",
      gatewayBaseUrl: "http://127.0.0.1:41002",
      instanceId,
      pid: 123,
      protocolVersion: 2,
      proxyBaseUrl: "http://127.0.0.1:41003",
    });
    expect(authorizations).toEqual(["Bearer control-secret"]);
    expect(await Bun.file(join(directory, ".runtime.json")).text()).not.toContain("control-secret");
  });

  test("rejects a stale daemon instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traicer-daemon-locator-"));
    await Bun.write(join(directory, ".runtime.json"), JSON.stringify({
      controlPort: 41001,
      gatewayPort: 41002,
      instanceId: "11111111-1111-4111-8111-111111111111",
      schema: "traicer.runtime/1",
    }));
    await expect(locateDaemon(directory, "control-secret", async () =>
      Response.json({ instanceId: "22222222-2222-4222-8222-222222222222" })
    )).rejects.toThrow("stale");
  });

  test("removes an unreachable stale descriptor but preserves a live authenticated boundary", async () => {
    const unreachable = await mkdtemp(join(tmpdir(), "traicer-daemon-locator-"));
    const descriptor = {
      controlPort: 41001,
      gatewayPort: 41002,
      instanceId: "11111111-1111-4111-8111-111111111111",
      schema: "traicer.runtime/1",
    };
    await Bun.write(join(unreachable, ".runtime.json"), JSON.stringify(descriptor));
    expect(await removeUnreachableRuntimeDescriptor(unreachable, "control-secret", async () => {
      throw new Error("connection refused");
    })).toBeTrue();
    expect(await runtimeDescriptorExists(unreachable)).toBeFalse();

    const live = await mkdtemp(join(tmpdir(), "traicer-daemon-locator-"));
    await Bun.write(join(live, ".runtime.json"), JSON.stringify(descriptor));
    expect(await removeUnreachableRuntimeDescriptor(live, "wrong-secret", async () =>
      new Response("unauthorized", { status: 401 })
    )).toBeFalse();
    expect(await runtimeDescriptorExists(live)).toBeTrue();
  });
});
