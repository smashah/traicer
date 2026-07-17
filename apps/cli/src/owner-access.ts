import { chmod, link, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface TraceSummary {
  readonly capturedAt: string;
  readonly client?: string;
  readonly provider?: "anthropic" | "openai";
  readonly state: string;
  readonly traceId: string;
  readonly updatedAt: string;
}

export interface TraceReadProgress {
  readonly completedBytes?: number;
  readonly phase: string;
  readonly totalBytes?: number;
}

export interface TraceReadResult {
  readonly source: "cache" | "storage";
  readonly trace: unknown;
}

type OwnerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const boundedInteger = (value: number, fallback: number, maximum: number): number =>
  Number.isInteger(value) ? Math.min(Math.max(value, 0), maximum) : fallback;

export const createOwnerAccessClient = (options: {
  readonly controlBaseUrl: string;
  readonly controlToken: string;
  readonly fetcher?: OwnerFetch;
}) => {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const headers = { authorization: `Bearer ${options.controlToken}` };
  return {
    cacheStats: async (): Promise<{ readonly bytes: number; readonly entries: number; readonly maxAgeDays: number }> => {
      const response = await fetcher(`${options.controlBaseUrl}/v1/cache/plaintext`, { headers });
      if (!response.ok) throw new Error("Traicer could not read plaintext cache status");
      const body = await response.json() as {
        readonly cache?: { readonly bytes?: unknown; readonly entries?: unknown };
        readonly maxAgeDays?: unknown;
      };
      if (
        typeof body.cache?.bytes !== "number"
        || typeof body.cache.entries !== "number"
        || typeof body.maxAgeDays !== "number"
      ) {
        throw new Error("Traicer returned invalid plaintext cache status");
      }
      return { bytes: body.cache.bytes, entries: body.cache.entries, maxAgeDays: body.maxAgeDays };
    },
    clearCache: async (): Promise<{ readonly removed: number }> => {
      const response = await fetcher(`${options.controlBaseUrl}/v1/cache/plaintext`, {
        headers,
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Traicer could not clear the plaintext cache");
      const body = await response.json() as { readonly cleared?: { readonly removed?: unknown } };
      if (typeof body.cleared?.removed !== "number") {
        throw new Error("Traicer returned an invalid plaintext cache result");
      }
      return { removed: body.cleared.removed };
    },
    list: async (input: { readonly limit?: number; readonly offset?: number } = {}): Promise<readonly TraceSummary[]> => {
      const limit = boundedInteger(input.limit ?? 50, 50, 100);
      const offset = boundedInteger(input.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
      const response = await fetcher(
        `${options.controlBaseUrl}/v1/traces?limit=${limit}&offset=${offset}`,
        { headers }
      );
      if (!response.ok) throw new Error("Traicer could not read the local trace inventory");
      const body = await response.json() as { readonly traces?: unknown };
      if (!Array.isArray(body.traces)) throw new Error("Traicer returned an invalid trace inventory");
      return body.traces as readonly TraceSummary[];
    },
    read: async (
      selector: string,
      onProgress?: (event: TraceReadProgress) => void
    ): Promise<TraceReadResult> => {
      const response = await fetcher(`${options.controlBaseUrl}/v1/traces/read`, {
        body: JSON.stringify({ selector }),
        headers: { ...headers, "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok || !response.body) {
        throw new Error("Traicer could not start owner trace inspection");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let result: TraceReadResult | undefined;
      const consume = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "progress" && typeof event.phase === "string") {
          onProgress?.({
            ...(typeof event.completedBytes === "number" ? { completedBytes: event.completedBytes } : {}),
            phase: event.phase,
            ...(typeof event.totalBytes === "number" ? { totalBytes: event.totalBytes } : {}),
          });
        } else if (event.type === "trace" && (event.source === "cache" || event.source === "storage")) {
          result = { source: event.source, trace: event.trace };
        } else if (event.type === "error") {
          throw new Error("The selected trace could not be read safely");
        }
      };
      for (;;) {
        const next = await reader.read();
        buffered += decoder.decode(next.value, { stream: !next.done });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) consume(line);
        if (next.done) break;
      }
      consume(buffered);
      if (!result) throw new Error("Traicer did not return the selected trace");
      return result;
    },
  };
};

export const formatTraceList = (traces: readonly TraceSummary[]): string => {
  if (traces.length === 0) return "No local traces found.";
  const heading = "TRACE ID                              STATE             PROVIDER    CLIENT          CAPTURED";
  return [
    heading,
    ...traces.map((trace) =>
      `${trace.traceId.padEnd(36)}  ${trace.state.padEnd(16)}  ${(trace.provider ?? "—").padEnd(10)}  ${(trace.client ?? "—").slice(0, 14).padEnd(14)}  ${trace.capturedAt}`
    ),
  ].join("\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
};

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

const toolMaterial = (value: unknown, result: unknown[] = []): readonly unknown[] => {
  if (Array.isArray(value)) {
    for (const entry of value) toolMaterial(entry, result);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "tool_use" || record.type === "tool_result" || Array.isArray(record.tool_calls)) {
      result.push(value);
    } else {
      for (const nested of Object.values(record)) toolMaterial(nested, result);
    }
  }
  return result;
};

export const formatCanonicalTrace = (trace: unknown): string => {
  if (!trace || typeof trace !== "object") throw new Error("Canonical trace rendering failed");
  const value = trace as Record<string, unknown>;
  const response = value.response && typeof value.response === "object"
    ? value.response as Record<string, unknown>
    : {};
  const tools = toolMaterial([value.request, response.body]);
  return [
    `Trace ${String(value.traceId ?? "unknown")}`,
    `Provider: ${String(value.provider ?? "unknown")} · Model: ${String(value.model ?? "unknown")} · Client: ${String(value.client ?? "unknown")}`,
    `Captured: ${String(value.capturedAt ?? "unknown")} · Response status: ${String(response.status ?? "unknown")}`,
    "",
    "REQUEST",
    pretty(value.request),
    "",
    "RESPONSE",
    pretty(response.body),
    "",
    "TOOL CALLS / RESULTS",
    tools.length ? pretty(tools) : "None",
    "",
    "USAGE",
    pretty(value.usage),
  ].join("\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
};

export type TraceExportFormat = "json" | "jsonl" | "markdown";

const renderExport = (traces: readonly unknown[], format: TraceExportFormat): string => {
  if (format === "jsonl") {
    return `${traces.map((trace) => JSON.stringify({ schema: "traicer.owner-export-record/1", trace })).join("\n")}\n`;
  }
  if (format === "markdown") {
    return `${traces.map((trace, index) => {
      const body = formatCanonicalTrace(trace);
      const longestRun = Math.max(0, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length));
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      return `# Traice ${index + 1}\n\n${fence}text\n${body}\n${fence}`;
    }).join("\n\n---\n\n")}\n`;
  }
  if (traces.length === 1) return `${JSON.stringify(traces[0], null, 2)}\n`;
  return `${JSON.stringify({ schema: "traicer.owner-export/1", traces }, null, 2)}\n`;
};

const assertSafeExportPath = async (input: string, absolute: string): Promise<void> => {
  const rawSegments = input.split(/[\\/]+/);
  if (rawSegments.includes("..")) throw new Error("Export destination must not contain path traversal segments");
  let current = absolute;
  for (;;) {
    const metadata = await lstat(current).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (metadata?.isSymbolicLink()) throw new Error("Export destination must not traverse a symbolic link");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
};

export const writeTraceExport = async (
  destination: string,
  trace: unknown | readonly unknown[],
  options: { readonly force?: boolean; readonly format?: TraceExportFormat } = {}
): Promise<string> => {
  const absolute = resolve(destination);
  await assertSafeExportPath(destination, absolute);
  const directory = dirname(absolute);
  const existingDirectory = await lstat(directory).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  await mkdir(directory, { mode: 0o700, recursive: true });
  await assertSafeExportPath(directory, directory);
  if (!existingDirectory) await chmod(directory, 0o700);
  const existing = await lstat(absolute).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error("Export destination must be a regular file");
  }
  if (existing && !options.force) throw new Error(`Export destination already exists: ${absolute}`);
  const temporary = `${absolute}.${crypto.randomUUID()}.tmp`;
  const traces = Array.isArray(trace) ? trace : [trace];
  try {
    await writeFile(temporary, renderExport(traces, options.format ?? "json"), { flag: "wx", mode: 0o600 });
    if (options.force) {
      await rename(temporary, absolute);
    } else {
      await link(temporary, absolute);
      await unlink(temporary);
    }
    await chmod(absolute, 0o600);
    return absolute;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};
