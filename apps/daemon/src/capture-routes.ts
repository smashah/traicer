import { bytesToBase64Url, sha256Hex } from "@traice/crypto";
import type { CaptureProvider } from "@traice/domain";

export type CaptureClient = "claude-code" | "codex" | "opencode";

export interface CaptureRoute {
  readonly captureRunId: string;
  readonly client: CaptureClient;
  readonly expiresAt: string;
  readonly projectScopeId: string;
  readonly providers: readonly CaptureProvider[];
  readonly routeId: string;
}

export interface CaptureRouteInput {
  readonly captureRunId: string;
  readonly client: CaptureClient;
  readonly projectScopeId: string;
  readonly providers: readonly CaptureProvider[];
  readonly routeId?: string;
  readonly ttlSeconds: number;
}

interface CaptureRouteRegistryDependencies {
  readonly now: () => number;
  readonly randomBytes: () => Uint8Array;
  readonly randomUuid: () => string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clients = new Set<CaptureClient>(["claude-code", "codex", "opencode"]);
const providers = new Set<CaptureProvider>(["anthropic", "openai"]);

const defaults: CaptureRouteRegistryDependencies = {
  now: () => Date.now(),
  randomBytes: () => crypto.getRandomValues(new Uint8Array(32)),
  randomUuid: () => crypto.randomUUID(),
};

const validateUuid = (value: string, label: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!uuidPattern.test(normalized)) throw new Error(`Expected a UUID ${label}`);
  return normalized;
};

export const createCaptureRouteRegistry = (
  overrides: Partial<CaptureRouteRegistryDependencies> = {}
) => {
  const dependencies = { ...defaults, ...overrides };
  const byTokenHash = new Map<string, CaptureRoute>();
  const tokenHashByRouteId = new Map<string, string>();

  const remove = (routeId: string): boolean => {
    const tokenHash = tokenHashByRouteId.get(routeId);
    if (!tokenHash) return false;
    tokenHashByRouteId.delete(routeId);
    byTokenHash.delete(tokenHash);
    return true;
  };

  return {
    issue: async (input: CaptureRouteInput): Promise<{
      readonly expiresAt: string;
      readonly routeId: string;
      readonly routeToken: string;
    }> => {
      const captureRunId = validateUuid(input.captureRunId, "capture run ID");
      const projectScopeId = validateUuid(input.projectScopeId, "project scope ID");
      if (!clients.has(input.client)) throw new Error("Unsupported capture client");
      const allowedProviders = [...new Set(input.providers)];
      if (allowedProviders.length === 0 || allowedProviders.some((provider) => !providers.has(provider))) {
        throw new Error("Expected at least one supported capture provider");
      }
      if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 86_400) {
        throw new Error("Capture route TTL must be between 60 and 86400 seconds");
      }
      const routeId = validateUuid(input.routeId ?? dependencies.randomUuid(), "route ID");
      if (tokenHashByRouteId.has(routeId)) throw new Error("Capture route ID is already active");
      const random = dependencies.randomBytes();
      if (random.byteLength !== 32) throw new Error("Capture route tokens require 32 random bytes");
      const routeToken = bytesToBase64Url(random);
      random.fill(0);
      const tokenHash = await sha256Hex(routeToken);
      const expiresAt = new Date(dependencies.now() + input.ttlSeconds * 1_000).toISOString();
      const route: CaptureRoute = {
        captureRunId,
        client: input.client,
        expiresAt,
        projectScopeId,
        providers: allowedProviders,
        routeId,
      };
      byTokenHash.set(tokenHash, route);
      tokenHashByRouteId.set(routeId, tokenHash);
      return { expiresAt, routeId, routeToken };
    },
    resolve: async (routeToken: string): Promise<CaptureRoute | undefined> => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(routeToken)) return undefined;
      const route = byTokenHash.get(await sha256Hex(routeToken));
      if (!route) return undefined;
      if (Date.parse(route.expiresAt) <= dependencies.now()) {
        remove(route.routeId);
        return undefined;
      }
      return route;
    },
    revoke: async (routeId: string): Promise<boolean> => remove(routeId.trim().toLowerCase()),
  };
};

export type CaptureRouteRegistry = ReturnType<typeof createCaptureRouteRegistry>;
