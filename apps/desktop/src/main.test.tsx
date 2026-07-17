import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invocations: { args: unknown; command: string }[] = [];
let confirmResult = true;
let intervalCallback: (() => void) | undefined;
let progressListener: ((event: { payload: { completedBytes?: number; phase?: string; totalBytes?: number } }) => void) | undefined;
let visibilityListener: (() => void) | undefined;
let visibilityState = "visible";
let releaseTraceRead: (() => void) | undefined;
let delayTraceRead = false;

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown) => {
    invocations.push({ args, command });
    if (command === "daemon_health") return {
      captureStatus: "healthy",
      controlPort: 44001,
      gatewayPort: 44002,
      health: { manifests: { committed: 4, pending: 2 }, marketplace: "disconnected", storage: "ready" },
      running: true,
    };
    if (command === "daemon_traces") return { traces: [{ capturedAt: "2026-07-17T08:00:00.000Z", state: "committed", traceId: "trace-1", updatedAt: "2026-07-17T08:00:01.000Z" }] };
    if (command === "daemon_work") return { items: [] };
    if (command === "daemon_read_trace") {
      if (delayTraceRead) await new Promise<void>((resolve) => { releaseTraceRead = resolve; });
      return { source: "storage", trace: { request: { input: "owner-visible" }, traceId: "trace-1" } };
    }
    if (command === "daemon_export_trace") return null;
    if (command === "autostart_status") return false;
    if (command === "proxy_trust_status") return { installed: false };
    if (command === "load_configuration") return null;
    return null;
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async (_name: string, listener: typeof progressListener) => {
    progressListener = listener;
    return () => { progressListener = undefined; };
  },
}));

const { App } = await import("./main");

const button = (renderer: ReactTestRenderer, label: string): ReactTestInstance =>
  renderer.root.findAllByType("button").find((candidate) => candidate.children.join("") === label)
    ?? (() => { throw new Error(`Missing button: ${label}`); })();

beforeEach(() => {
  invocations.length = 0;
  confirmResult = true;
  intervalCallback = undefined;
  progressListener = undefined;
  visibilityListener = undefined;
  visibilityState = "visible";
  releaseTraceRead = undefined;
  delayTraceRead = false;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    clearInterval: () => undefined,
    confirm: () => confirmResult,
    setInterval: (callback: () => void) => { intervalCallback = callback; return 1; },
  }});
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    addEventListener: (name: string, listener: () => void) => {
      if (name === "visibilitychange") visibilityListener = listener;
    },
    get visibilityState() { return visibilityState; },
    removeEventListener: () => undefined,
  }});
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
});

const renderApp = async (): Promise<ReactTestRenderer> => {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<App />);
    await Bun.sleep(1);
  });
  await act(async () => {
    intervalCallback?.();
    await Bun.sleep(1);
  });
  return renderer!;
};

describe("desktop owner trace access", () => {
  test("requires explicit confirmation before reading or exporting plaintext", async () => {
    const renderer = await renderApp();
    expect(JSON.stringify(renderer.toJSON())).toContain("Reconciliation pending: ");
    expect(JSON.stringify(renderer.toJSON())).toContain("2");
    confirmResult = false;
    await act(async () => { button(renderer, "View").props.onClick(); await Bun.sleep(1); });
    await act(async () => { button(renderer, "Export…").props.onClick(); await Bun.sleep(1); });
    expect(invocations.some(({ command }) => command === "daemon_read_trace")).toBeFalse();
    expect(invocations.some(({ command }) => command === "daemon_export_trace")).toBeFalse();
    await act(async () => { renderer.unmount(); });
  });

  test("shows progress, reveals one trace, and clears plaintext when hidden", async () => {
    const renderer = await renderApp();
    await act(async () => {
      button(renderer, "View").props.onClick();
      progressListener?.({ payload: { completedBytes: 50, phase: "download", totalBytes: 100 } });
      await Bun.sleep(2);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("owner-visible");
    visibilityState = "hidden";
    await act(async () => { visibilityListener?.(); });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("owner-visible");
    await act(async () => { renderer.unmount(); });
  });

  test("does not restore an in-flight plaintext read after the window is hidden", async () => {
    delayTraceRead = true;
    const renderer = await renderApp();
    await act(async () => { button(renderer, "View").props.onClick(); await Bun.sleep(1); });
    visibilityState = "hidden";
    await act(async () => { visibilityListener?.(); });
    await act(async () => { releaseTraceRead?.(); await Bun.sleep(2); });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("owner-visible");
    await act(async () => { renderer.unmount(); });
  });

  test("clears the bounded decrypted cache from the native desktop control", async () => {
    const renderer = await renderApp();
    await act(async () => { button(renderer, "Clear decrypted cache").props.onClick(); await Bun.sleep(2); });
    expect(invocations.some(({ command }) => command === "daemon_clear_trace_cache")).toBeTrue();
    expect(JSON.stringify(renderer.toJSON())).toContain("Decrypted trace cache cleared.");
    await act(async () => { renderer.unmount(); });
  });

  test("reports native save-dialog cancellation without creating a plaintext result", async () => {
    const renderer = await renderApp();
    await act(async () => { button(renderer, "Export…").props.onClick(); await Bun.sleep(2); });
    expect(invocations.filter(({ command }) => command === "daemon_export_trace")).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("Export cancelled; no plaintext file was created.");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("owner-visible");
    await act(async () => { renderer.unmount(); });
  });
});
