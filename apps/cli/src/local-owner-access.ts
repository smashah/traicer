import { resolve } from "node:path";

import { base64UrlToBytes } from "@traice/crypto";
import {
  lifecycleStates,
  openOperationalState,
  type LifecycleState,
  type TraceInventoryOptions,
} from "@traice/state-sqlite";
import { createS3CompatibleObjectStore } from "@traice/storage-s3";
import { createPlaintextTraceCache, createTraceReader } from "@traice/trace-reader";

import { readTraicerConfig, requiredSecret, type Provider } from "./config";
import { locateDaemon } from "./daemon-locator";
import type { TraceReadProgress, TraceSummary } from "./owner-access";

export interface LocalTraceFilters {
  readonly client?: string;
  readonly limit: number;
  readonly offset: number;
  readonly provider?: Provider;
  readonly since?: string;
  readonly state?: LifecycleState;
}

export const parseTraceFilters = (values: {
  readonly client?: string | undefined;
  readonly limit?: string | undefined;
  readonly offset?: string | undefined;
  readonly provider?: string | undefined;
  readonly since?: string | undefined;
  readonly state?: string | undefined;
}): LocalTraceFilters => {
  const limit = Number(values.limit ?? "50");
  const offset = Number(values.offset ?? "0");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("--offset must be a non-negative safe integer");
  }
  if (values.provider !== undefined && values.provider !== "anthropic" && values.provider !== "openai") {
    throw new Error("--provider must be anthropic or openai");
  }
  if (values.state !== undefined && !lifecycleStates.includes(values.state as LifecycleState)) {
    throw new Error(`--state must be one of: ${lifecycleStates.join(", ")}`);
  }
  if (values.client !== undefined && (values.client.trim() === "" || values.client.length > 80)) {
    throw new Error("--client must be a non-empty value of at most 80 characters");
  }
  if (values.since !== undefined && !Number.isFinite(Date.parse(values.since))) {
    throw new Error("--since must be an ISO-8601 timestamp");
  }
  return {
    ...(values.client ? { client: values.client } : {}),
    limit,
    offset,
    ...(values.provider ? { provider: values.provider as Provider } : {}),
    ...(values.since ? { since: new Date(values.since).toISOString() } : {}),
    ...(values.state ? { state: values.state as LifecycleState } : {}),
  };
};

const configuredCacheBytes = (): number | undefined => {
  const value = process.env.TRAICER_PLAINTEXT_CACHE_MAX_BYTES;
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("TRAICER_PLAINTEXT_CACHE_MAX_BYTES must be a non-negative safe integer");
  }
  return parsed;
};

export const createLocalOwnerAccess = async (directory: string) => {
  const config = await readTraicerConfig(directory);
  const state = openOperationalState(resolve(directory, "traicer-state.db"));
  const maxBytes = configuredCacheBytes();
  const cache = createPlaintextTraceCache({
    directory: resolve(directory, "cache", "decrypted"),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  await cache.purge();

  const reader = () => {
    let objectStore: ReturnType<typeof createS3CompatibleObjectStore> | undefined;
    const getEnvelope: ReturnType<typeof createS3CompatibleObjectStore>["getEnvelope"] = (...input) => {
      objectStore ??= createS3CompatibleObjectStore({
        addressingStyle: config.storage.addressingStyle,
        bucket: config.storage.bucket,
        endpoint: config.storage.endpoint,
        prefix: config.storage.prefix,
        signingRegion: config.storage.signingRegion,
        storageCapabilityProfileId: `s3-compatible:${config.storage.provider}`,
      }, {
        accessKeyId: requiredSecret("TRAICER_STORAGE_ACCESS_KEY_ID"),
        secretAccessKey: requiredSecret("TRAICER_STORAGE_SECRET_ACCESS_KEY"),
        ...(process.env.TRAICER_STORAGE_SESSION_TOKEN
          ? { sessionToken: process.env.TRAICER_STORAGE_SESSION_TOKEN }
          : {}),
      });
      return objectStore.getEnvelope(...input);
    };
    return createTraceReader({
      cache,
      getEnvelope,
      resolveTrace: async (selector) => state.ownerTrace(selector, config.storage.prefix),
      wrappingKey: base64UrlToBytes(requiredSecret("TRAICER_VAULT_KEY")),
    });
  };

  return {
    cacheStats: async () => ({ ...(await cache.stats()), maxAgeDays: 7 }),
    clearCache: () => cache.clear(),
    close: () => state.close(),
    list: async (input: Partial<TraceInventoryOptions> = {}): Promise<readonly TraceSummary[]> =>
      state.traceInventory({
        limit: input.limit ?? 50,
        offset: input.offset ?? 0,
        ...(input.client ? { client: input.client } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.since ? { since: input.since } : {}),
        ...(input.state ? { state: input.state } : {}),
      }),
    read: async (selector: string, onProgress?: (event: TraceReadProgress) => void) => {
      const result = await reader().read(selector, onProgress ? { onProgress } : {});
      return { source: result.source, trace: result.trace } as const;
    },
    status: async () => {
      const controlToken = process.env.TRAICER_CONTROL_TOKEN;
      const capture = controlToken && await locateDaemon(directory, controlToken).then(
        () => "running" as const,
        () => "stopped" as const
      ) || "stopped";
      return {
        capture,
        marketplace: process.env.TRAICER_MARKETPLACE_CREDENTIAL ? "configured" as const : "offline" as const,
        storage: process.env.TRAICER_STORAGE_ACCESS_KEY_ID && process.env.TRAICER_STORAGE_SECRET_ACCESS_KEY
          ? "configured" as const
          : "missing" as const,
      };
    },
  };
};
