import { createCliRenderer } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { TraceReadProgress, TraceReadResult, TraceSummary } from "./owner-access";

export interface ExplorerStatus {
  readonly capture: "running" | "stopped" | "unknown";
  readonly marketplace: "configured" | "offline" | "unknown";
  readonly storage: "configured" | "missing" | "unknown";
}

export interface ExplorerClient {
  readonly list: (input?: { readonly limit?: number; readonly offset?: number }) => Promise<readonly TraceSummary[]>;
  readonly read: (
    selector: string,
    onProgress?: (event: TraceReadProgress) => void
  ) => Promise<TraceReadResult>;
  readonly status?: () => Promise<ExplorerStatus>;
}

export interface ExplorerAppProps {
  readonly client: ExplorerClient;
  readonly initialResult?: TraceReadResult;
  readonly initialStatus?: ExplorerStatus;
  readonly initialTraces?: readonly TraceSummary[];
  readonly onCopy?: (text: string) => void;
  readonly onExport?: (traceId: string, trace: unknown) => Promise<string>;
}

type DetailTab = "conversation" | "json" | "metadata";
type Confirmation = "clipboard" | "export" | "reveal";

const colors = {
  accent: "#7dd3fc",
  background: "#07111f",
  border: "#334155",
  dim: "#94a3b8",
  error: "#fda4af",
  panel: "#0f1b2d",
  selected: "#18324f",
  text: "#e2e8f0",
  warning: "#fde68a",
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

const conversation = (trace: unknown): string => {
  const value = record(trace);
  const response = record(value.response);
  return [
    "REQUEST",
    JSON.stringify(value.request, null, 2),
    "",
    "RESPONSE",
    JSON.stringify(response.body, null, 2),
    "",
    "USAGE",
    JSON.stringify(value.usage, null, 2),
  ].join("\n");
};

const metadata = (trace: unknown): string => {
  const value = record(trace);
  return [
    `Schema: ${String(value.schema ?? "unknown")}`,
    `Trace: ${String(value.traceId ?? "unknown")}`,
    `Provider: ${String(value.provider ?? "unknown")}`,
    `Model: ${String(value.model ?? "unknown")}`,
    `Client: ${String(value.client ?? "unknown")}`,
    `Captured: ${String(value.capturedAt ?? "unknown")}`,
  ].join("\n");
};

export function ExplorerApp({
  client,
  initialResult,
  initialStatus = { capture: "unknown", marketplace: "unknown", storage: "unknown" },
  initialTraces,
  onCopy,
  onExport,
}: ExplorerAppProps) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const narrow = width < 92;
  const [traces, setTraces] = useState<readonly TraceSummary[]>(initialTraces ?? []);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(initialTraces === undefined);
  const [progress, setProgress] = useState<TraceReadProgress>();
  const [result, setResult] = useState<TraceReadResult | undefined>(initialResult);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string | undefined>(
    initialResult ? `Loaded from ${initialResult.source}` : undefined
  );
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const confirmationRef = useRef<Confirmation | undefined>(undefined);
  const confirmationInFlightRef = useRef(false);
  const [filtering, setFiltering] = useState(false);
  const filteringRef = useRef<boolean>(false);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<DetailTab>("conversation");
  const [detailOpen, setDetailOpen] = useState(Boolean(initialResult));

  const visibleTraces = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return traces;
    return traces.filter((trace) => [
      trace.traceId,
      trace.state,
      trace.provider,
      trace.client,
      trace.capturedAt,
    ].some((value) => value?.toLowerCase().includes(needle)));
  }, [filter, traces]);
  const selected = visibleTraces[selectedIndex];
  const json = useMemo(() => result ? JSON.stringify(result.trace, null, 2) : "", [result]);
  const detail = result
    ? tab === "json" ? json : tab === "metadata" ? metadata(result.trace) : conversation(result.trace)
    : "";

  const clearPlaintext = () => {
    setResult(undefined);
    setProgress(undefined);
    confirmationRef.current = undefined;
    setConfirmation(undefined);
    setDetailOpen(false);
    setMessage(undefined);
    setTab("conversation");
  };

  const reload = async () => {
    setLoading(true);
    setError(undefined);
    clearPlaintext();
    try {
      const next = await client.list({ limit: 100, offset: 0 });
      setTraces(next);
      setSelectedIndex(0);
    } catch {
      setError("The local trace inventory is unavailable.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialTraces === undefined) void reload();
  }, []);

  const inspect = async () => {
    if (!selected || loading) return;
    confirmationRef.current = undefined;
    setConfirmation(undefined);
    setLoading(true);
    setDetailOpen(true);
    setProgress({ phase: "lookup" });
    setResult(undefined);
    setMessage(undefined);
    setError(undefined);
    try {
      const next = await client.read(selected.traceId, setProgress);
      setResult(next);
      setMessage(`Loaded from ${next.source}`);
    } catch {
      setError("The selected trace could not be read safely.");
    } finally {
      confirmationRef.current = undefined;
      setConfirmation(undefined);
      setLoading(false);
      setProgress(undefined);
    }
  };

  const exportSelected = async () => {
    if (!onExport || !selected || !result) return;
    setLoading(true);
    setError(undefined);
    try {
      setMessage(`Exported to ${await onExport(selected.traceId, result.trace)}`);
    } catch {
      setError("The plaintext export failed safely.");
    } finally {
      setLoading(false);
    }
  };

  const confirm = () => {
    const action = confirmationRef.current;
    confirmationRef.current = undefined;
    // OpenTUI terminals can emit more than one event for a single Enter. Keep
    // the confirmation from being interpreted as a fresh reveal request while
    // the confirmed action settles.
    confirmationInFlightRef.current = true;
    setTimeout(() => { confirmationInFlightRef.current = false; }, 250);
    setConfirmation(undefined);
    if (action === "reveal") void inspect();
    else if (action === "export") void exportSelected();
    else if (action === "clipboard" && result) {
      onCopy?.(json);
      setMessage("Decrypted trace copied after explicit confirmation.");
    }
  };

  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    key.preventDefault();
    key.stopPropagation();
    const pressed = (name: string) => key.name === name || key.sequence === name;
    if (filteringRef.current) {
      if (pressed("escape") || pressed("enter") || pressed("return")) {
        filteringRef.current = false;
        setFiltering(false);
        setSelectedIndex(0);
      } else if (pressed("backspace")) {
        setFilter((value) => value.slice(0, -1));
      } else if (!key.ctrl && !key.meta && key.sequence?.length === 1) {
        setFilter((value) => `${value}${key.sequence}`);
      }
      return;
    }
    if (confirmationRef.current) {
      if (pressed("enter") || pressed("return") || pressed("y")) confirm();
      else if (pressed("escape") || pressed("n")) {
        confirmationRef.current = undefined;
        setConfirmation(undefined);
      }
      return;
    }
    if (pressed("q") || (key.ctrl && pressed("c"))) {
      clearPlaintext();
      renderer.destroy();
      return;
    }
    if (pressed("escape")) {
      if (detailOpen || result) clearPlaintext();
      else renderer.destroy();
      return;
    }
    if (loading) return;
    if (pressed("/")) {
      filteringRef.current = true;
      setFiltering(true);
    } else if (pressed("up") || pressed("k")) {
      setSelectedIndex((index) => Math.max(0, index - 1));
      clearPlaintext();
    } else if (pressed("down") || pressed("j")) {
      setSelectedIndex((index) => Math.min(Math.max(0, visibleTraces.length - 1), index + 1));
      clearPlaintext();
    } else if (pressed("enter") || pressed("return")) {
      if (confirmationInFlightRef.current) return;
      setDetailOpen(true);
      confirmationRef.current = "reveal";
      setConfirmation("reveal");
    } else if (pressed("tab") && result) {
      setTab((current) => current === "conversation" ? "json" : current === "json" ? "metadata" : "conversation");
    } else if (pressed("r")) {
      void reload();
    } else if (pressed("e") && result && onExport) {
      confirmationRef.current = "export";
      setConfirmation("export");
    } else if (pressed("c") && result && onCopy) {
      confirmationRef.current = "clipboard";
      setConfirmation("clipboard");
    }
  });

  const completed = progress?.completedBytes;
  const total = progress?.totalBytes;
  const percentage = completed !== undefined && total
    ? Math.min(100, Math.round(completed / total * 100))
    : undefined;
  const hideList = narrow && detailOpen;

  return (
    <box backgroundColor={colors.background} flexDirection="column" height="100%" width="100%">
      <box border borderColor={colors.border} flexDirection="column" height={6} paddingX={2} paddingY={1}>
        <text fg={colors.text}>{`TRAICES EXPLORER · capture: ${initialStatus.capture} · storage: ${initialStatus.storage}\nmarket: ${initialStatus.marketplace} · encrypted objects fetch only after reveal · filter: ${filter || "none"}`}</text>
      </box>
      <box flexDirection={narrow ? "column" : "row"} flexGrow={1} minHeight={1}>
        {!hideList ? <box
          backgroundColor={colors.panel}
          border
          borderColor={colors.border}
          flexDirection="column"
          height={narrow ? "100%" : "100%"}
          padding={1}
          width={narrow ? "100%" : 44}
        >
          <text fg={colors.accent}><strong>Local inventory</strong></text>
          {filtering ? <text fg={colors.warning}>Filter: {filter}▌</text> : null}
          {loading && traces.length === 0 ? <text fg={colors.dim}>Loading safe metadata…</text> : null}
          {!loading && visibleTraces.length === 0 ? <text fg={colors.dim}>{filter ? "No traces match the filter." : "No local traces yet."}</text> : null}
          <scrollbox flexGrow={1} focused={false}>
            {visibleTraces.map((trace, index) => (
              <box backgroundColor={index === selectedIndex ? colors.selected : colors.panel} flexDirection="column" key={trace.traceId} paddingX={1}>
                <text fg={index === selectedIndex ? colors.accent : colors.text}>
                  {index === selectedIndex ? "› " : "  "}{trace.traceId}
                </text>
                <text fg={colors.dim}>  {trace.state} · {trace.provider ?? "unknown"} · {trace.capturedAt}</text>
              </box>
            ))}
          </scrollbox>
        </box> : null}
        {(!narrow || detailOpen) ? <box border borderColor={colors.border} flexDirection="column" flexGrow={1} minHeight={1} padding={1}>
          <text fg={colors.accent}><strong>{selected ? selected.traceId : "Trace detail"}</strong></text>
          {result ? <text fg={colors.dim}>conversation · json · metadata — active: {tab}</text> : null}
          {confirmation ? <box border borderColor={colors.warning} flexDirection="column" marginTop={1} padding={1}>
            <text fg={colors.warning}>{`PLAINTEXT WARNING: ${confirmation === "reveal"
              ? "Reveal decrypted prompts, responses, and source fragments now?"
              : confirmation === "export"
              ? "Export the currently revealed sensitive plaintext trace?"
              : "Copy the currently revealed sensitive plaintext trace to the clipboard?"}`}</text>
            <text fg={colors.dim}>Enter/y confirms · Esc/n cancels</text>
          </box> : null}
          {progress ? <box flexDirection="column" marginTop={1}>
            <text fg={colors.text}>{progress.phase}{percentage === undefined ? "" : ` ${percentage}%`}</text>
            <box backgroundColor={colors.border} height={1} width={30}>
              <box backgroundColor={colors.accent} height={1} width={percentage === undefined ? 2 : Math.max(1, Math.round(percentage * 0.3))} />
            </box>
          </box> : null}
          {error ? <text fg={colors.error}>{error}</text> : null}
          {message ? <text fg={colors.dim}>{message}</text> : null}
          {!result && !progress && !confirmation && selected ? <text fg={colors.dim}>Press Enter, review the warning, then confirm to decrypt this trace.</text> : null}
          {result && !confirmation ? <scrollbox flexGrow={1} focused={false} marginTop={1}>
            <text fg={colors.text}>{detail}</text>
          </scrollbox> : null}
        </box> : null}
      </box>
      <box border borderColor={colors.border} paddingX={2}>
        <text fg={colors.dim}>{narrow
          ? "↑/↓ move · Enter reveal · / filter · Tab tabs · e export · c copy · q quit"
          : "↑/k ↓/j move · Enter reveal · / filter · Tab tabs · e export · c copy · r refresh · Esc back · q quit"}</text>
      </box>
    </box>
  );
}

export const launchExplorer = async (
  client: ExplorerClient,
  onExport: (traceId: string, trace: unknown) => Promise<string>
): Promise<void> => {
  const status = await client.status?.().catch(() => undefined)
    ?? { capture: "unknown", marketplace: "unknown", storage: "unknown" };
  let resolveDestroyed: (() => void) | undefined;
  const destroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve;
  });
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    onDestroy: () => resolveDestroyed?.(),
    targetFps: 30,
  });
  const closeOnBackground = () => renderer.destroy();
  renderer.on("blur", closeOnBackground);
  try {
    createRoot(renderer).render(<ExplorerApp
      client={client}
      initialStatus={status}
      onCopy={(text) => renderer.copyToClipboardOSC52(text)}
      onExport={onExport}
    />);
    await destroyed;
  } finally {
    renderer.off("blur", closeOnBackground);
    renderer.destroy();
  }
};

export const smokeExplorerRenderer = async (): Promise<void> => {
  const renderer = await createCliRenderer({
    autoFocus: false,
    bufferedOutput: "memory",
    exitOnCtrlC: false,
    height: 12,
    targetFps: 1,
    width: 80,
  });
  try {
    createRoot(renderer).render(<ExplorerApp
      client={{ list: async () => [], read: async () => { throw new Error("unused"); } }}
      initialStatus={{ capture: "stopped", marketplace: "offline", storage: "configured" }}
      initialTraces={[]}
    />);
    renderer.requestRender();
    await Bun.sleep(25);
  } finally {
    renderer.destroy();
  }
};
