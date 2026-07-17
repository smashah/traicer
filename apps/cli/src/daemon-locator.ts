import { lstat, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

export interface DaemonConnection {
  readonly controlBaseUrl: string;
  readonly gatewayBaseUrl: string;
  readonly instanceId: string;
  readonly pid?: number;
  readonly protocolVersion?: 1 | 2;
  readonly proxyBaseUrl?: string;
}

type DaemonFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const descriptorPath = (directory: string): string => resolve(directory, ".runtime.json");

export const runtimeDescriptorExists = async (directory: string): Promise<boolean> =>
  lstat(descriptorPath(directory)).then(() => true).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  });

export const removeUnreachableRuntimeDescriptor = async (
  directory: string,
  controlToken: string,
  fetcher: DaemonFetch = globalThis.fetch
): Promise<boolean> => {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(descriptorPath(directory), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    value = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  let controlPort: number;
  try {
    controlPort = port(value.controlPort);
  } catch {
    await rm(descriptorPath(directory), { force: true });
    return true;
  }
  const response = await fetcher(`http://127.0.0.1:${controlPort}/v1/health`, {
    headers: { authorization: `Bearer ${controlToken}` },
  }).catch(() => undefined);
  if (response) return false;
  await rm(descriptorPath(directory), { force: true });
  return true;
};

const port = (value: unknown): number => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error("Traicer runtime descriptor has an invalid port");
  }
  return Number(value);
};

export const locateDaemon = async (
  directory: string,
  controlToken: string,
  fetcher: DaemonFetch = globalThis.fetch
): Promise<DaemonConnection> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(descriptorPath(directory), "utf8"));
  } catch {
    throw new Error("Traicer isn't running; start it with `traicer start` in another terminal");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Traicer runtime descriptor is invalid");
  const value = raw as Record<string, unknown>;
  if (value.schema !== "traicer.runtime/1" || typeof value.instanceId !== "string") {
    throw new Error("Traicer runtime descriptor is invalid");
  }
  const controlBaseUrl = `http://127.0.0.1:${port(value.controlPort)}`;
  const gatewayBaseUrl = `http://127.0.0.1:${port(value.gatewayPort)}`;
  const proxyBaseUrl = value.proxyPort === undefined
    ? undefined
    : `http://127.0.0.1:${port(value.proxyPort)}`;
  const response = await fetcher(`${controlBaseUrl}/v1/health`, {
    headers: { authorization: `Bearer ${controlToken}` },
  }).catch(() => undefined);
  if (!response?.ok) throw new Error("The recorded Traicer daemon isn't reachable; restart `traicer start`");
  const health = await response.json() as { readonly instanceId?: unknown };
  if (health.instanceId !== value.instanceId) throw new Error("The Traicer runtime descriptor is stale; restart `traicer start`");
  return {
    controlBaseUrl,
    gatewayBaseUrl,
    instanceId: value.instanceId,
    ...(Number.isInteger(value.pid) && Number(value.pid) > 0 ? { pid: Number(value.pid) } : {}),
    ...(value.protocolVersion === 1 || value.protocolVersion === 2
      ? { protocolVersion: value.protocolVersion }
      : {}),
    ...(proxyBaseUrl ? { proxyBaseUrl } : {}),
  };
};
