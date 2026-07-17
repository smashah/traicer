import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import { ExplorerApp } from "../src/explorer";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  await act(async () => setup?.renderer.destroy());
  setup = undefined;
});

const key = (name: string) => {
  let defaultPrevented = false;
  let propagationStopped = false;
  return {
    ctrl: false,
    get defaultPrevented() { return defaultPrevented; },
    eventType: "press" as const,
    meta: false,
    name,
    option: false,
    preventDefault: () => { defaultPrevented = true; },
    get propagationStopped() { return propagationStopped; },
    repeated: false,
    sequence: name === "enter" ? "\r" : name,
    shift: false,
    stopPropagation: () => { propagationStopped = true; },
  };
};

const press = async (name: string, delay = 5) => {
  await act(() => {
    (setup?.renderer.keyInput as unknown as {
      emit: (event: string, value: ReturnType<typeof key>) => void;
    }).emit("keypress", key(name));
  });
  await act(async () => { await Bun.sleep(delay); });
  await act(async () => { await setup?.renderOnce(); });
  await act(async () => { await Bun.sleep(5); });
  await act(async () => { await setup?.renderOnce(); });
};

describe("Traices Explorer", () => {
  test("lists safe metadata first and downloads only after the selected trace is requested", async () => {
    let reads = 0;
    let copies = 0;
    let exports = 0;
    const initialTraces = [{
      capturedAt: "2026-07-17T08:00:00.000Z",
      state: "committed",
      traceId: "trace-1",
      updatedAt: "2026-07-17T08:00:01.000Z",
    }];
    setup = await testRender(<ExplorerApp initialTraces={initialTraces} client={{
      list: async () => initialTraces,
      read: async (_selector, onProgress) => {
        reads += 1;
        onProgress?.({ completedBytes: 50, phase: "download", totalBytes: 100 });
        await Bun.sleep(1);
        return {
          source: "storage",
          trace: { schema: "traice.trace/1", traceId: "trace-1", request: { input: "owner-visible" } },
        };
      },
    }} onCopy={() => { copies += 1; }} onExport={async () => { exports += 1; return "/safe/export"; }} />, { height: 24, width: 100 });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("trace-1");
    expect(setup.captureCharFrame()).not.toContain("owner-visible");
    expect(reads).toBe(0);

    await press("enter");
    expect(setup.captureCharFrame()).toContain("PLAINTEXT WARNING");
    expect(reads).toBe(0);
    await press("y", 10);
    expect(reads).toBe(1);
    expect(setup.captureCharFrame()).toContain("owner-visible");
    expect(copies).toBe(0);
    expect(exports).toBe(0);

    for (const action of ["c", "e"] as const) {
      await press(action);
      expect(setup.captureCharFrame()).toContain("PLAINTEXT WARNING");
      expect(action === "c" ? copies : exports).toBe(0);
      await press("y");
    }
    expect(copies).toBe(1);
    expect(exports).toBe(1);
  });

  test("filters safe metadata without decrypting non-selected traces", async () => {
    const traces = [
      { capturedAt: "2026-07-17T08:00:00.000Z", provider: "openai" as const, state: "committed", traceId: "openai-trace", updatedAt: "2026-07-17T08:00:01.000Z" },
      { capturedAt: "2026-07-17T07:00:00.000Z", provider: "anthropic" as const, state: "failed", traceId: "anthropic-trace", updatedAt: "2026-07-17T07:00:01.000Z" },
    ];
    setup = await testRender(<ExplorerApp initialTraces={traces} client={{
      list: async () => traces,
      read: async () => { throw new Error("unused"); },
    }} />, { height: 24, width: 120 });
    await setup.renderOnce();
    for (const name of ["/", "a", "n", "t", "h", "escape"] as const) {
      await act(async () => {
        (setup?.renderer.keyInput as unknown as { emit: (event: string, value: ReturnType<typeof key>) => void })
          .emit("keypress", key(name));
        await setup?.renderOnce();
      });
    }
    expect(setup.captureCharFrame()).toContain("anthropic-trace");
    expect(setup.captureCharFrame()).not.toContain("openai-trace");
  });

  test("keeps read failures safe and destroys the renderer on quit", async () => {
    const traces = [{ capturedAt: "2026-07-17T08:00:00.000Z", state: "committed", traceId: "trace-error", updatedAt: "2026-07-17T08:00:01.000Z" }];
    setup = await testRender(<ExplorerApp initialTraces={traces} client={{
      list: async () => traces,
      read: async () => { await Bun.sleep(1); throw new Error("private storage failure canary"); },
    }} />, { height: 24, width: 100 });
    await setup.renderOnce();
    await press("enter");
    expect(setup.captureCharFrame()).toContain("PLAINTEXT WARNING");
    await press("y");
    expect(setup.captureCharFrame()).toContain("could not be read safely");
    expect(setup.captureCharFrame()).not.toContain("private storage failure canary");
    await act(async () => {
      (setup?.renderer.keyInput as unknown as { emit: (event: string, value: ReturnType<typeof key>) => void })
        .emit("keypress", key("q"));
      await Bun.sleep(5);
    });
    expect(setup.renderer.isDestroyed).toBeTrue();
    setup = undefined;
  });

  test("keeps stable layouts at 80x24, 120x40, narrow width, and after resize", async () => {
    const traces = [{
      capturedAt: "2026-07-17T08:00:00.000Z",
      provider: "openai" as const,
      state: "committed",
      traceId: "trace-layout",
      updatedAt: "2026-07-17T08:00:01.000Z",
    }];
    setup = await testRender(<ExplorerApp
      initialStatus={{ capture: "running", marketplace: "offline", storage: "configured" }}
      initialTraces={traces}
      client={{
      list: async () => traces,
      read: async () => ({ source: "cache", trace: { traceId: "trace-layout" } }),
    }} />, { height: 24, width: 80 });
    await setup.renderOnce();
    const at80 = setup.captureCharFrame();
    expect(at80).toContain("TRAICES EXPLORER");
    expect(at80).toContain("capture: running");
    expect(at80).toContain("market: offline");
    expect(at80).toContain("trace-layout");
    expect(at80).not.toContain("Trace detail");

    await act(async () => {
      setup?.resize(120, 40);
      await Bun.sleep(150);
      await setup?.flush();
    });
    const at120 = setup.captureCharFrame();
    expect(at120).toContain("Local inventory");
    expect(at120).toMatch(/Esc.back/);

    await act(async () => {
      setup?.resize(60, 20);
      await Bun.sleep(150);
      await setup?.flush();
    });
    const narrow = setup.captureCharFrame();
    expect(narrow).toContain("trace-layout");
    expect(narrow).not.toContain("Trace detail");
  });

  test("renders decrypted detail and its cache source", async () => {
    setup = await testRender(<ExplorerApp
      client={{ list: async () => [], read: async () => { throw new Error("unused"); } }}
      initialResult={{
        source: "storage",
        trace: { schema: "traice.trace/1", traceId: "trace-1", request: { input: "owner-visible" } },
      }}
      initialTraces={[{
        capturedAt: "2026-07-17T08:00:00.000Z",
        state: "committed",
        traceId: "trace-1",
        updatedAt: "2026-07-17T08:00:01.000Z",
      }]}
    />, { height: 24, width: 100 });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("owner-visible");
    expect(setup.captureCharFrame()).toContain("storage");
  });

  test("shows the keyboard contract and a clear empty state", async () => {
    setup = await testRender(<ExplorerApp initialTraces={[]} client={{
      list: async () => [],
      read: async () => { throw new Error("unused"); },
    }} />, { height: 18, width: 80 });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/No.local.traces yet/);
    expect(frame).toContain("Enter");
    expect(frame).toContain("quit");
  });
});
