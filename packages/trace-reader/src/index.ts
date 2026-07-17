import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import { decryptTraceEnvelope, sha256Hex } from "@traice/crypto";
import { CanonicalTraceSchema, type CanonicalTrace } from "@traice/domain";
import { Schema } from "effect";

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const CACHE_FILE = /^([a-f0-9]{64})\.json\.gz$/;

export type TraceReadPhase =
  | "lookup"
  | "download"
  | "verify"
  | "decrypt"
  | "validate"
  | "cache";

export interface TraceReadProgress {
  readonly completedBytes?: number;
  readonly phase: TraceReadPhase;
  readonly totalBytes?: number;
}

export interface TraceLocator {
  readonly canonicalHash: string;
  readonly ciphertextHash: string;
  readonly traceId: string;
}

export type TraceReadErrorCode =
  | "decrypt_failed"
  | "integrity_failed"
  | "local_state_unavailable"
  | "not_found"
  | "oversized"
  | "schema_invalid"
  | "storage_unavailable";

export class TraceReadError extends Error {
  constructor(readonly code: TraceReadErrorCode) {
    super(`Owner trace read failed safely (${code})`);
    this.name = "TraceReadError";
  }
}

export interface PlaintextTraceCache {
  readonly clear: () => Promise<{ readonly removed: number }>;
  readonly get: (ciphertextHash: string) => Promise<Uint8Array | undefined>;
  readonly purge: () => Promise<{ readonly expired: number; readonly evicted: number }>;
  readonly put: (ciphertextHash: string, canonicalBytes: Uint8Array) => Promise<void>;
  readonly remove: (ciphertextHash: string) => Promise<void>;
  readonly stats: () => Promise<{ readonly bytes: number; readonly entries: number }>;
}

export interface PlaintextTraceCacheOptions {
  readonly directory: string;
  readonly maxAgeMs?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly removeFile?: (path: string) => Promise<void>;
}

interface CacheEntry {
  readonly bytes: number;
  readonly hash: string;
  readonly modifiedAt: number;
  readonly path: string;
}

const cachePath = (directory: string, hash: string) =>
  resolve(directory, `${hash}.json.gz`);

const validateHash = (hash: string): void => {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("A lowercase SHA-256 ciphertext hash is required");
  }
};

const unlinkIfPresent = async (
  path: string,
  removeFile: (path: string) => Promise<void> = unlink,
): Promise<boolean> => {
  try {
    await removeFile(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

export const createPlaintextTraceCache = (
  options: PlaintextTraceCacheOptions
): PlaintextTraceCache => {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? Date.now;
  const removeCachedFile = (path: string) => unlinkIfPresent(path, options.removeFile ?? unlink);
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("The plaintext cache retention must be positive");
  }
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error("The plaintext cache size limit cannot be negative");
  }

  const ensureDirectory = async (): Promise<void> => {
    await mkdir(options.directory, { mode: 0o700, recursive: true });
    await chmod(options.directory, 0o700);
  };

  const entries = async (): Promise<readonly CacheEntry[]> => {
    await ensureDirectory();
    const result: CacheEntry[] = [];
    for (const name of await readdir(options.directory)) {
      const match = CACHE_FILE.exec(name);
      const path = resolve(options.directory, name);
      if (!match) {
        if (name.endsWith(".tmp")) await removeCachedFile(path);
        continue;
      }
      const metadata = await stat(path).catch(() => undefined);
      if (metadata?.isFile()) {
        result.push({
          bytes: metadata.size,
          hash: match[1]!,
          modifiedAt: metadata.mtimeMs,
          path,
        });
      }
    }
    return result;
  };

  const remove = async (ciphertextHash: string): Promise<void> => {
    validateHash(ciphertextHash);
    await removeCachedFile(cachePath(options.directory, ciphertextHash));
  };

  const purge = async (): Promise<{ readonly expired: number; readonly evicted: number }> => {
    let expired = 0;
    let evicted = 0;
    const retained: CacheEntry[] = [];
    for (const entry of await entries()) {
      if (now() - entry.modifiedAt > maxAgeMs) {
        if (await removeCachedFile(entry.path)) expired += 1;
      } else {
        retained.push(entry);
      }
    }
    let total = retained.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of retained.sort((left, right) => left.modifiedAt - right.modifiedAt)) {
      if (total <= maxBytes) break;
      if (await removeCachedFile(entry.path)) {
        total -= entry.bytes;
        evicted += 1;
      }
    }
    return { evicted, expired };
  };

  return {
    clear: async () => {
      const current = await entries();
      let removed = 0;
      for (const entry of current) {
        if (await removeCachedFile(entry.path)) removed += 1;
      }
      return { removed };
    },
    get: async (ciphertextHash) => {
      validateHash(ciphertextHash);
      await purge();
      const path = cachePath(options.directory, ciphertextHash);
      const metadata = await stat(path).catch(() => undefined);
      if (!metadata) return undefined;
      if (now() - metadata.mtimeMs > maxAgeMs) {
        await removeCachedFile(path);
        return undefined;
      }
      try {
        return Uint8Array.from(Bun.gunzipSync(Uint8Array.from(await readFile(path))));
      } catch {
        await removeCachedFile(path);
        return undefined;
      }
    },
    purge,
    put: async (ciphertextHash, canonicalBytes) => {
      validateHash(ciphertextHash);
      await ensureDirectory();
      const destination = cachePath(options.directory, ciphertextHash);
      const temporary = resolve(
        options.directory,
        `.${ciphertextHash}.${crypto.randomUUID()}.tmp`
      );
      const compressed = Uint8Array.from(Bun.gzipSync(Uint8Array.from(canonicalBytes), { level: 9 }));
      try {
        await writeFile(temporary, compressed, { flag: "wx", mode: 0o600 });
        await rename(temporary, destination);
        await chmod(destination, 0o600);
        const timestamp = now() / 1_000;
        await utimes(destination, timestamp, timestamp);
      } finally {
        await removeCachedFile(temporary);
      }
      await purge();
    },
    remove,
    stats: async () => {
      await purge();
      const current = await entries();
      return {
        bytes: current.reduce((sum, entry) => sum + entry.bytes, 0),
        entries: current.length,
      };
    },
  };
};

export const parseCanonicalTrace = (
  canonicalBytes: Uint8Array,
  expectedTraceId: string
): CanonicalTrace => {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(canonicalBytes));
  } catch {
    throw new Error("Decrypted trace is not valid JSON");
  }
  let trace: CanonicalTrace;
  try {
    trace = Schema.decodeUnknownSync(CanonicalTraceSchema)(value);
  } catch {
    throw new Error("Decrypted trace does not match the canonical trace schema");
  }
  if (trace.traceId !== expectedTraceId) {
    throw new Error("Decrypted trace does not match the canonical trace schema");
  }
  return trace;
};

export interface TraceReaderDependencies {
  readonly cache?: PlaintextTraceCache;
  readonly getEnvelope: (
    ciphertextHash: string,
    onProgress?: (progress: { readonly completedBytes: number; readonly totalBytes?: number }) => void
  ) => Promise<Uint8Array>;
  readonly maxEnvelopeBytes?: number;
  readonly resolveTrace: (selector: string) => Promise<TraceLocator | undefined>;
  readonly wrappingKey: Uint8Array;
}

export const createTraceReader = (dependencies: TraceReaderDependencies) => ({
  read: async (
    selector: string,
    options: { readonly onProgress?: (event: TraceReadProgress) => void } = {}
  ): Promise<{
    readonly canonicalBytes: Uint8Array;
    readonly locator: TraceLocator;
    readonly source: "cache" | "storage";
    readonly trace: CanonicalTrace;
  }> => {
    options.onProgress?.({ phase: "lookup" });
    const locator = await dependencies.resolveTrace(selector).catch(() => {
      throw new TraceReadError("local_state_unavailable");
    });
    if (!locator) throw new TraceReadError("not_found");
    try {
      validateHash(locator.ciphertextHash);
      validateHash(locator.canonicalHash);
    } catch {
      throw new TraceReadError("local_state_unavailable");
    }

    const cached = await dependencies.cache?.get(locator.ciphertextHash);
    if (cached) {
      try {
        if (await sha256Hex(cached) !== locator.canonicalHash) {
          throw new Error("Cached canonical hash mismatch");
        }
        return {
          canonicalBytes: cached,
          locator,
          source: "cache",
          trace: parseCanonicalTrace(cached, locator.traceId),
        };
      } catch {
        await dependencies.cache?.remove(locator.ciphertextHash);
      }
    }

    let downloadReported = false;
    const envelope = await dependencies.getEnvelope(locator.ciphertextHash, (progress) => {
      if (progress.totalBytes !== undefined && progress.totalBytes > (dependencies.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES)) {
        throw new TraceReadError("oversized");
      }
      downloadReported = true;
      options.onProgress?.({ phase: "download", ...progress });
    }).catch((error: unknown) => {
      if (error instanceof TraceReadError) throw error;
      throw new TraceReadError("storage_unavailable");
    });
    if (envelope.byteLength > (dependencies.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES)) {
      throw new TraceReadError("oversized");
    }
    if (!downloadReported) {
      options.onProgress?.({
        completedBytes: envelope.byteLength,
        phase: "download",
        totalBytes: envelope.byteLength,
      });
    }
    options.onProgress?.({ phase: "verify" });
    if (await sha256Hex(envelope) !== locator.ciphertextHash) {
      throw new TraceReadError("integrity_failed");
    }
    options.onProgress?.({ phase: "decrypt" });
    const canonicalBytes = await decryptTraceEnvelope({
      envelope,
      wrappingKey: dependencies.wrappingKey,
    }).catch(() => {
      throw new TraceReadError("decrypt_failed");
    });
    if (await sha256Hex(canonicalBytes) !== locator.canonicalHash) {
      throw new TraceReadError("integrity_failed");
    }
    options.onProgress?.({ phase: "validate" });
    let trace: CanonicalTrace;
    try {
      trace = parseCanonicalTrace(canonicalBytes, locator.traceId);
    } catch {
      throw new TraceReadError("schema_invalid");
    }
    if (dependencies.cache) {
      options.onProgress?.({ phase: "cache" });
      await dependencies.cache.put(locator.ciphertextHash, canonicalBytes);
    }
    return { canonicalBytes, locator, source: "storage", trace };
  },
});
