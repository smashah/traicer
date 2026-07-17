import type { DaemonConnection } from "./daemon-locator";

type ServiceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ServiceStatus {
  readonly captureStatus: string;
  readonly committedManifests: number;
  readonly controlUrl: string;
  readonly database: string;
  readonly gateway: string;
  readonly gatewayUrl: string;
  readonly marketplace: "connected" | "disconnected" | "unavailable";
  readonly pendingManifests: number;
  readonly pid?: number;
  readonly protocolVersion?: 1 | 2;
  readonly proxyUrl?: string;
  readonly running: true;
  readonly storage: "ready" | "unavailable";
}

export interface ProviderUrls {
  readonly anthropic: string;
  readonly expiresAt: string;
  readonly openai: string;
}

export const createServiceClient = (options: {
  readonly connection: DaemonConnection;
  readonly controlToken: string;
  readonly fetcher?: ServiceFetch;
}) => {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const authorization = { authorization: `Bearer ${options.controlToken}` };
  return {
    status: async (): Promise<ServiceStatus> => {
      const response = await fetcher(`${options.connection.controlBaseUrl}/v1/health`, {
        headers: authorization,
      });
      if (!response.ok) throw new Error("Traicer health is unavailable");
      const body = await response.json() as {
        readonly captureStatus?: unknown;
        readonly database?: unknown;
        readonly gateway?: unknown;
        readonly manifests?: { readonly committed?: unknown; readonly pending?: unknown };
        readonly marketplace?: unknown;
        readonly storage?: unknown;
      };
      return {
        captureStatus: typeof body.captureStatus === "string" ? body.captureStatus : "unknown",
        committedManifests: typeof body.manifests?.committed === "number" ? body.manifests.committed : 0,
        controlUrl: options.connection.controlBaseUrl,
        database: typeof body.database === "string" ? body.database : "unknown",
        gateway: typeof body.gateway === "string" ? body.gateway : "unknown",
        gatewayUrl: options.connection.gatewayBaseUrl,
        marketplace: body.marketplace === "connected"
          ? "connected"
          : body.marketplace === "unavailable"
          ? "unavailable"
          : "disconnected",
        pendingManifests: typeof body.manifests?.pending === "number" ? body.manifests.pending : 0,
        ...(options.connection.pid === undefined ? {} : { pid: options.connection.pid }),
        ...(options.connection.protocolVersion === undefined
          ? {}
          : { protocolVersion: options.connection.protocolVersion }),
        ...(options.connection.proxyBaseUrl === undefined
          ? {}
          : { proxyUrl: options.connection.proxyBaseUrl }),
        running: true,
        storage: body.storage === "ready" ? "ready" : "unavailable",
      };
    },
    urls: async (projectScopeId: string): Promise<ProviderUrls> => {
      const response = await fetcher(`${options.connection.controlBaseUrl}/v1/capture-routes`, {
        body: JSON.stringify({
          captureRunId: crypto.randomUUID(),
          client: "opencode",
          projectScopeId,
          providers: ["anthropic", "openai"],
          routeId: crypto.randomUUID(),
          ttlSeconds: 43_200,
        }),
        headers: { ...authorization, "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Traicer could not issue provider gateway URLs");
      const body = await response.json() as {
        readonly data?: { readonly expiresAt?: unknown; readonly routeToken?: unknown };
      };
      if (typeof body.data?.expiresAt !== "string" || typeof body.data.routeToken !== "string") {
        throw new Error("Traicer returned invalid provider gateway URLs");
      }
      return {
        anthropic: `${options.connection.gatewayBaseUrl}/anthropic/${body.data.routeToken}`,
        expiresAt: body.data.expiresAt,
        openai: `${options.connection.gatewayBaseUrl}/openai/${body.data.routeToken}/v1`,
      };
    },
  };
};

export const formatServiceStatus = (status: ServiceStatus): string => [
  `Daemon: running${status.pid ? ` (pid ${status.pid})` : ""}`,
  `Capture: ${status.captureStatus}`,
  `Storage database: ${status.database}`,
  `Seller storage: ${status.storage}`,
  `Gateway: ${status.gateway} at ${status.gatewayUrl}`,
  ...(status.proxyUrl ? [`Explicit TLS proxy: ${status.proxyUrl}`] : []),
  `Marketplace: ${status.marketplace === "connected" ? "account connected" : status.marketplace === "unavailable" ? "account configured, reconciliation unavailable" : "account not connected"}`,
  `Manifests: ${status.committedManifests} reconciled, ${status.pendingManifests} pending`,
].join("\n");

export const formatProviderUrls = (urls: ProviderUrls): string => [
  "These short-lived URLs are bearer capabilities. Do not paste them into issues or logs.",
  `Anthropic base URL: ${urls.anthropic}`,
  `OpenAI base URL:    ${urls.openai}`,
  `Expires:            ${urls.expiresAt}`,
].join("\n");

export const formatInstructions = (urls?: ProviderUrls): string => [
  "Run supported coding agents through a scoped route:",
  "  traicer run -- claude",
  "  traicer run -- codex",
  "  traicer run -- opencode",
  "",
  "Link the current repository once before the first run:",
  "  traicer project link",
  "",
  ...(urls
    ? [
        "Direct SDK configuration (short-lived bearer capabilities):",
        `  ANTHROPIC_BASE_URL=${JSON.stringify(urls.anthropic)}`,
        `  OPENAI_BASE_URL=${JSON.stringify(urls.openai)}`,
        `  Expires ${urls.expiresAt}`,
      ]
    : ["Use `traicer urls --reveal` only when a direct SDK needs the raw base URLs."]),
].join("\n");
