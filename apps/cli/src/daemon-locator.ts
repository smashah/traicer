import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface DaemonConnection {
  readonly controlBaseUrl: string;
  readonly gatewayBaseUrl: string;
  readonly instanceId: string;
}

type DaemonFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
    raw = JSON.parse(await readFile(resolve(directory, ".runtime.json"), "utf8"));
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
  const response = await fetcher(`${controlBaseUrl}/v1/health`, {
    headers: { authorization: `Bearer ${controlToken}` },
  }).catch(() => undefined);
  if (!response?.ok) throw new Error("The recorded Traicer daemon isn't reachable; restart `traicer start`");
  const health = await response.json() as { readonly instanceId?: unknown };
  if (health.instanceId !== value.instanceId) throw new Error("The Traicer runtime descriptor is stale; restart `traicer start`");
  return { controlBaseUrl, gatewayBaseUrl, instanceId: value.instanceId };
};
