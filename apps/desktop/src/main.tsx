import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type Provider = "anthropic" | "openai";
type CaptureState = "degraded" | "error" | "healthy" | "paused" | "stopped";

interface DaemonStatus {
  captureStatus: CaptureState;
  controlPort?: number;
  gatewayPort?: number;
  gatewayUrl?: string;
  proxyUrl?: string;
  health?: Record<string, unknown>;
  running: boolean;
}

interface LocalConfig {
  bucket: string;
  client: string;
  deviceId: string;
  endpoint: string;
  marketplaceApi: string;
  marketplaceConnected: boolean;
  prefix: string;
  provider: Provider;
  publicKey: string;
  region: string;
  signerKeyId: string;
}

interface WorkItem {
  agreement: Record<string, unknown> | null;
  buyerKey: { fingerprint: string } | null;
  dataset: { datasetRoot: string; id: string; status: string } | null;
  quote: { id: string; licenceVersion: string; status: string } | null;
  request: { id: string; requestedTraceCount: number; status: string };
}

interface UpdateStatus {
  available: boolean;
  notes?: string;
  version?: string;
}
interface TraceSummary {
  capturedAt: string;
  state: string;
  traceId: string;
  updatedAt: string;
}
interface TraceDetail {
  source: "cache" | "storage";
  trace: unknown;
}

const initialStatus: DaemonStatus = { captureStatus: "stopped", running: false };
const inputStyle: React.CSSProperties = { background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, boxSizing: "border-box", padding: "9px 11px", width: "100%" };
const buttonStyle: React.CSSProperties = { background: "#0f172a", border: 0, borderRadius: 8, color: "white", cursor: "pointer", fontWeight: 700, padding: "10px 14px" };

export function App() {
  const [status, setStatus] = useState<DaemonStatus>(initialStatus);
  const [savedConfig, setSavedConfig] = useState<LocalConfig>();
  const [provider, setProvider] = useState<Provider>("openai");
  const [client, setClient] = useState("codex");
  const [marketplaceApi, setMarketplaceApi] = useState("https://api.traice.market");
  const [marketplaceCredential, setMarketplaceCredential] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("traice");
  const [region, setRegion] = useState("auto");
  const [storageAccessKeyId, setStorageAccessKeyId] = useState("");
  const [storageSecret, setStorageSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [work, setWork] = useState<WorkItem[]>([]);
  const [autostart, setAutostart] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>();
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [proxyTrusted, setProxyTrusted] = useState(false);
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [traceDetail, setTraceDetail] = useState<TraceDetail>();
  const [traceProgress, setTraceProgress] = useState<string>();
  const traceOperationRef = useRef(0);
  const traceReadActiveRef = useRef(false);
  const visibleRef = useRef(typeof document === "undefined" || document.visibilityState !== "hidden");

  const clearRevealedTrace = () => {
    traceOperationRef.current += 1;
    traceReadActiveRef.current = false;
    setTraceDetail(undefined);
    setSelectedTraceId(undefined);
    setTraceProgress(undefined);
  };

  const refresh = async () => {
    try {
      const next = await invoke<DaemonStatus>("daemon_health");
      setStatus(next);
      if (!next.running) {
        clearRevealedTrace();
      }
    } catch {
      setStatus(initialStatus);
    }
  };

  const refreshWork = async () => {
    try {
      const response = await invoke<{ items: WorkItem[] }>("daemon_work");
      setWork(response.items);
    } catch {
      setWork([]);
    }
  };

  const refreshTraces = async () => {
    try {
      const response = await invoke<{ traces: TraceSummary[] }>("daemon_traces");
      setTraces(response.traces);
    } catch {
      setTraces([]);
    }
  };

  useEffect(() => {
    void refresh();
    void invoke<boolean>("autostart_status").then(setAutostart).catch(() => undefined);
    void invoke<{ installed: boolean }>("proxy_trust_status").then((value) => setProxyTrusted(value.installed)).catch(() => undefined);
    void invoke<LocalConfig | null>("load_configuration").then((config) => {
      if (!config) return;
      setSavedConfig(config);
      setProvider(config.provider);
      setClient(config.client);
      setMarketplaceApi(config.marketplaceApi);
      setEndpoint(config.endpoint);
      setBucket(config.bucket);
      setPrefix(config.prefix);
      setRegion(config.region);
    }).catch(() => undefined);
    const timer = window.setInterval(() => {
      void refresh();
      void refreshWork();
      void refreshTraces();
    }, 5_000);
    const handleVisibilityChange = () => {
      visibleRef.current = document.visibilityState !== "hidden";
      if (!visibleRef.current) {
        clearRevealedTrace();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    let removeProgressListener: (() => void) | undefined;
    void listen<{ completedBytes?: number; phase?: string; totalBytes?: number }>("trace-read-progress", (event) => {
      if (!visibleRef.current || !traceReadActiveRef.current) return;
      const { completedBytes, phase, totalBytes } = event.payload;
      const percent = completedBytes !== undefined && totalBytes
        ? ` ${Math.min(100, Math.round(completedBytes / totalBytes * 100))}%`
        : "";
      setTraceProgress(`${phase ?? "working"}${percent}`);
    }).then((unlisten) => { removeProgressListener = unlisten; }).catch(() => undefined);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      removeProgressListener?.();
    };
  }, []);

  const startSaved = async (config = savedConfig) => {
    if (!config) throw new Error("Configure Traicer first");
    setBusy(true);
    setError(undefined);
    clearRevealedTrace();
    try {
      setStatus(await invoke<DaemonStatus>("daemon_start"));
      await refreshWork();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const configure = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    clearRevealedTrace();
    try {
      if (!savedConfig && (!storageSecret || !storageAccessKeyId)) {
        throw new Error("Seller storage credentials are required");
      }
      const config = await invoke<LocalConfig>("configure_device", { input: {
        bucket,
        client,
        endpoint,
        marketplaceApi,
        marketplaceCredential,
        prefix,
        provider,
        region,
        storageAccessKeyId,
        storageSecret,
      }});
      setMarketplaceCredential("");
      setStorageSecret("");
      setSavedConfig(config);
      if (status.running) await invoke("daemon_stop");
      await startSaved(config);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const control = async (command: "daemon_pause" | "daemon_resume" | "daemon_stop") => {
    setBusy(true);
    setError(undefined);
    try {
      await invoke(command, command === "daemon_pause" ? { reason: "user" } : {});
      if (command === "daemon_stop") {
        clearRevealedTrace();
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const commitDataset = async (requestId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await invoke("daemon_commit_dataset", { requestId });
      await refreshWork();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const proposeAgreement = async (requestId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await invoke("daemon_propose_agreement", { requestId });
      await refreshWork();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const prepareDelivery = async (requestId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await invoke("daemon_prepare_delivery", { requestId });
      await refreshWork();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteTrace = async (traceId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await invoke("daemon_delete_trace", {
        reason: "Seller requested permanent deletion from local and remote storage",
        traceId,
      });
      await refreshTraces();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const inspectTrace = async (traceId: string) => {
    if (!window.confirm("Reveal decrypted prompts, responses, tool calls, and source fragments in the Traicer window?")) return;
    const operation = traceOperationRef.current + 1;
    traceOperationRef.current = operation;
    traceReadActiveRef.current = true;
    setBusy(true);
    setError(undefined);
    setSelectedTraceId(traceId);
    setTraceDetail(undefined);
    setTraceProgress("Downloading, verifying, and decrypting the selected trace…");
    try {
      const detail = await invoke<TraceDetail>("daemon_read_trace", { traceId });
      if (traceOperationRef.current === operation && visibleRef.current) {
        setTraceDetail(detail);
      }
    } catch (cause) {
      if (traceOperationRef.current === operation && visibleRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (traceOperationRef.current === operation) {
        traceReadActiveRef.current = false;
        setTraceProgress(undefined);
      }
      setBusy(false);
    }
  };

  const clearTraceCache = async () => {
    clearRevealedTrace();
    setBusy(true);
    setError(undefined);
    try {
      await invoke("daemon_clear_trace_cache");
      setTraceProgress("Decrypted trace cache cleared.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportTrace = async (traceId: string) => {
    if (!window.confirm("Export this sensitive decrypted trace to a plaintext file you choose?")) return;
    setBusy(true);
    setError(undefined);
    setTraceProgress("Preparing an owner-only plaintext export…");
    try {
      const destination = await invoke<string | null>("daemon_export_trace", { traceId });
      if (!destination) {
        setTraceProgress("Export cancelled; no plaintext file was created.");
        return;
      }
      setSelectedTraceId(traceId);
      setTraceProgress(`Exported to ${destination}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setTraceProgress(undefined);
    } finally {
      setBusy(false);
    }
  };

  const setLaunchAtLogin = async (enabled: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setAutostart(await invoke<boolean>("autostart_set", { enabled }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const checkForUpdate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setUpdate(await invoke<UpdateStatus>("update_check"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const installUpdate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await invoke("update_install");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const setProxyTrust = async (installed: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await invoke<{ installed: boolean }>(installed ? "proxy_trust_install" : "proxy_trust_remove");
      setProxyTrusted(result.installed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <main style={{ background: "#f1f5f9", color: "#0f172a", fontFamily: "Inter, system-ui, sans-serif", minHeight: "100vh", padding: 20 }}>
    <header style={{ display: "flex", justifyContent: "space-between", marginBottom: 18 }}><div><p style={{ fontFamily: "monospace", fontSize: 11, letterSpacing: 1.4, margin: 0 }}>TRAICER · LOCAL SOVEREIGNTY BOUNDARY</p><h1 style={{ fontSize: 24, margin: "6px 0" }}>Capture control</h1></div><span style={{ alignSelf: "start", background: status.captureStatus === "healthy" ? "#dcfce7" : status.captureStatus === "paused" ? "#fef3c7" : "#e2e8f0", borderRadius: 999, fontSize: 12, fontWeight: 700, padding: "6px 10px" }}>{status.captureStatus}</span></header>

    <section style={{ background: "white", borderRadius: 14, marginBottom: 16, padding: 16 }}><h2 style={{ fontSize: 16, marginTop: 0 }}>Live state</h2><p style={{ color: "#475569", fontSize: 13 }}>Daemon: {status.running ? `loopback:${status.controlPort}` : "stopped"}</p><p style={{ color: "#475569", fontSize: 13 }}>Gateway: {status.gatewayPort ? `loopback:${status.gatewayPort}` : "not started"}</p>{status.health ? <p style={{ color: "#475569", fontSize: 13 }}>Seller storage: {String(status.health.storage ?? "unavailable")} · Marketplace: {String(status.health.marketplace ?? "disconnected")} · Reconciliation pending: {String((status.health.manifests as { pending?: unknown } | undefined)?.pending ?? 0)}</p> : null}<label style={{ alignItems: "center", display: "flex", fontSize: 13, gap: 8, marginBottom: 12 }}><input checked={autostart} disabled={busy} onChange={(event) => void setLaunchAtLogin(event.target.checked)} type="checkbox" />Launch Traicer when I sign in</label><div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{!status.running && savedConfig ? <button disabled={busy} onClick={() => void startSaved()} style={buttonStyle}>Start</button> : null}{status.running && status.captureStatus !== "paused" ? <button disabled={busy} onClick={() => void control("daemon_pause")} style={buttonStyle}>Pause capture</button> : null}{status.running && status.captureStatus === "paused" ? <button disabled={busy} onClick={() => void control("daemon_resume")} style={buttonStyle}>Resume</button> : null}{status.running ? <button disabled={busy} onClick={() => void control("daemon_stop")} style={{ ...buttonStyle, background: "#b42318" }}>Stop</button> : null}<button disabled={busy} onClick={() => void checkForUpdate()} style={{ ...buttonStyle, background: "#334155" }}>Check signed update</button>{update?.available ? <button disabled={busy} onClick={() => void installUpdate()} style={{ ...buttonStyle, background: "#0369a1" }}>Install {update.version}</button> : null}{proxyTrusted ? <button disabled={busy || status.running} onClick={() => void setProxyTrust(false)} style={{ ...buttonStyle, background: "#b42318" }}>Remove local proxy CA</button> : <button disabled={busy} onClick={() => void setProxyTrust(true)} style={{ ...buttonStyle, background: "#0369a1" }}>Trust local proxy CA</button>}</div>{update && !update.available ? <p style={{ color: "#475569", fontSize: 12 }}>Traicer is up to date.</p> : null}{update?.notes ? <p style={{ color: "#475569", fontSize: 12 }}>{update.notes}</p> : null}<p style={{ color: "#475569", fontSize: 12 }}>Selected-host TLS capture is {proxyTrusted ? "trusted for this user" : "disabled until you explicitly trust the generated local CA"}. Remove trust only while the daemon is stopped. Listener addresses omit adapter credentials; use <code>traice instructions</code> for configured client routes.</p>{status.gatewayUrl && savedConfig ? <p style={{ background: "#0f172a", borderRadius: 8, color: "white", fontFamily: "monospace", fontSize: 11, marginBottom: 0, overflowWrap: "anywhere", padding: 10 }}>Gateway listener {status.gatewayUrl}</p> : null}{status.proxyUrl ? <p style={{ background: "#0f172a", borderRadius: 8, color: "white", fontFamily: "monospace", fontSize: 11, overflowWrap: "anywhere", padding: 10 }}>Proxy listener {status.proxyUrl}</p> : null}</section>

    {status.running ? <section style={{ background: "white", borderRadius: 14, display: "grid", gap: 10, marginBottom: 16, padding: 16 }}><h2 style={{ fontSize: 16, margin: 0 }}>Marketplace work</h2>{work.length === 0 ? <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>No active seller requests require local work.</p> : work.map((item) => <div key={item.request.id} style={{ border: "1px solid #cbd5e1", borderRadius: 10, padding: 12 }}><strong>Request {item.request.id.slice(0, 8)}</strong><p style={{ color: "#475569", fontSize: 12 }}>{item.request.status} · up to {item.request.requestedTraceCount} traces</p>{item.dataset ? <p style={{ fontFamily: "monospace", fontSize: 11, overflowWrap: "anywhere" }}>Root {item.dataset.datasetRoot}</p> : <button disabled={busy} onClick={() => void commitDataset(item.request.id)} style={buttonStyle}>Commit eligible local dataset</button>}{item.dataset && item.quote && !item.agreement ? <button disabled={busy} onClick={() => void proposeAgreement(item.request.id)} style={{ ...buttonStyle, marginLeft: 8 }}>Sign exact root and propose agreement</button> : null}{item.agreement && item.buyerKey && ["agreement_accepted", "seller_marked_paid"].includes(item.request.status) ? <button disabled={busy} onClick={() => void prepareDelivery(item.request.id)} style={{ ...buttonStyle, marginLeft: 8 }}>Prepare buyer-encrypted delivery</button> : null}</div>)}</section> : null}

    {status.running ? <section style={{ background: "white", borderRadius: 14, display: "grid", gap: 10, marginBottom: 16, padding: 16 }}><div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}><h2 style={{ fontSize: 16, margin: 0 }}>Local trace lifecycle</h2><button disabled={busy} onClick={() => void clearTraceCache()} style={{ ...buttonStyle, background: "#334155" }}>Clear decrypted cache</button></div><p style={{ color: "#64748b", fontSize: 12, margin: 0 }}>Trace content is fetched and decrypted only when you choose View or Export. Decrypted cache entries are compressed, bounded, and removed after seven days.</p>{traces.length === 0 ? <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>No local trace metadata is available.</p> : traces.map((trace) => <div key={trace.traceId} style={{ alignItems: "center", border: selectedTraceId === trace.traceId ? "2px solid #0369a1" : "1px solid #cbd5e1", borderRadius: 10, display: "flex", flexWrap: "wrap", gap: 8, padding: 12 }}><div style={{ flex: 1, minWidth: 240 }}><strong style={{ fontFamily: "monospace", fontSize: 12 }}>{trace.traceId}</strong><p style={{ color: "#475569", fontSize: 11, margin: "4px 0 0" }}>{trace.state} · {new Date(trace.capturedAt).toLocaleString()}</p></div>{["encrypted", "manifest_pending", "committed"].includes(trace.state) ? <><button disabled={busy} onClick={() => void inspectTrace(trace.traceId)} style={{ ...buttonStyle, background: "#0369a1" }}>View</button><button disabled={busy} onClick={() => void exportTrace(trace.traceId)} style={{ ...buttonStyle, background: "#334155" }}>Export…</button></> : null}{trace.state === "committed" ? <button disabled={busy} onClick={() => void deleteTrace(trace.traceId)} style={{ ...buttonStyle, background: "#b42318" }}>Delete and tombstone</button> : null}</div>)}{traceProgress ? <p style={{ background: "#e0f2fe", borderRadius: 8, color: "#075985", fontSize: 12, margin: 0, padding: 10 }}>{traceProgress}</p> : null}{traceDetail ? <div style={{ background: "#07111f", borderRadius: 10, color: "#e2e8f0", padding: 12 }}><div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}><p style={{ color: "#7dd3fc", fontSize: 12, marginTop: 0 }}>Loaded from {traceDetail.source}. This plaintext is visible in the app and may be sensitive.</p><button onClick={clearRevealedTrace} style={{ ...buttonStyle, background: "#334155" }}>Close plaintext</button></div><pre style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11, margin: 0, maxHeight: 420, overflow: "auto", whiteSpace: "pre-wrap" }}>{JSON.stringify(traceDetail.trace, null, 2)}</pre></div> : null}</section> : null}

    <form onSubmit={configure} style={{ background: "white", borderRadius: 14, display: "grid", gap: 10, padding: 16 }}><h2 style={{ fontSize: 16, margin: 0 }}>Configure or connect account</h2><p style={{ color: "#475569", fontSize: 12, lineHeight: 1.5, margin: 0 }}>Secrets are transferred once to the daemon over stdin and stored in the operating-system credential vault. Existing seller-storage credentials and device keys are preserved when their fields are left blank.</p>{savedConfig && !savedConfig.marketplaceConnected ? <p style={{ background: "#fff7ed", borderRadius: 8, color: "#9a3412", fontSize: 12, margin: 0, padding: 10 }}><strong>Local-first capture is active.</strong> Connect a Traice Market account when signup becomes available so pending safe metadata can reconcile automatically. Encrypted trace bodies remain in your storage.</p> : null}<select style={inputStyle} value={provider} onChange={(event) => { const next = event.target.value as Provider; setProvider(next); setClient(next === "anthropic" ? "claude-code" : "codex"); }}><option value="openai">OpenAI-compatible · Codex/OpenCode</option><option value="anthropic">Anthropic Messages · Claude Code</option></select><input style={inputStyle} value={client} onChange={(event) => setClient(event.target.value)} placeholder="Client label" required /><input style={inputStyle} value={marketplaceApi} onChange={(event) => setMarketplaceApi(event.target.value)} placeholder="Marketplace API" type="url" required /><input style={inputStyle} value={marketplaceCredential} onChange={(event) => setMarketplaceCredential(event.target.value)} placeholder="Marketplace credential (optional during onboarding)" type="password" /><input style={inputStyle} value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="S3-compatible HTTPS endpoint" type="url" required /><input style={inputStyle} value={bucket} onChange={(event) => setBucket(event.target.value)} placeholder="Seller bucket" required /><div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr" }}><input style={inputStyle} value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="Prefix" required /><input style={inputStyle} value={region} onChange={(event) => setRegion(event.target.value)} placeholder="Signing region" required /></div><input style={inputStyle} value={storageAccessKeyId} onChange={(event) => setStorageAccessKeyId(event.target.value)} placeholder={savedConfig ? "Storage access key ID (leave blank to keep existing)" : "Storage access key ID"} type="password" required={!savedConfig} /><input style={inputStyle} value={storageSecret} onChange={(event) => setStorageSecret(event.target.value)} placeholder={savedConfig ? "Storage secret (leave blank to keep existing)" : "Storage secret access key"} type="password" required={!savedConfig} /><button disabled={busy} style={buttonStyle} type="submit">{busy ? "Applying secure configuration…" : marketplaceCredential ? "Connect account and start" : savedConfig ? "Apply and start" : "Start local-first capture"}</button></form>
    {error ? <p role="alert" style={{ background: "#fee4e2", borderRadius: 8, color: "#b42318", fontSize: 13, padding: 12 }}>{error}</p> : null}
    <p style={{ color: "#64748b", fontSize: 11, lineHeight: 1.5 }}>Do not attach raw traces, credentials, source code, prompts, repository names, or private object locations to support requests. The live status above contains bounded operational metadata only.</p>
  </main>;
}

if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing application root");
  createRoot(root).render(<App />);
}
