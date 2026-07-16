import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join, win32 } from "node:path";

declare const cloudflareAccountIdBrand: unique symbol;

export type CloudflareAccountId = string & {
  readonly [cloudflareAccountIdBrand]: true;
};

export interface CloudflareAccount {
  readonly id: CloudflareAccountId;
  readonly name: string;
}

export interface WranglerIdentity {
  readonly accounts: readonly CloudflareAccount[];
  readonly email?: string;
}

export type WranglerDiscovery =
  | { readonly identity: WranglerIdentity; readonly status: "authenticated" }
  | { readonly status: "invalid-response" | "unauthenticated" | "unavailable" };

interface WranglerDependencies {
  readonly findWranglers: () => readonly string[];
  readonly runWrangler: (
    command: string[]
  ) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

interface WranglerSearchOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly resolveExecutable?: (candidate: string) => string | undefined;
}

const accountIdPattern = /^[0-9a-f]{32}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const defaultResolveExecutable = (candidate: string): string | undefined => {
  try {
    accessSync(candidate, constants.X_OK);
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
};

export const findWranglerExecutables = ({
  environment = process.env,
  platform = process.platform,
  resolveExecutable = defaultResolveExecutable,
}: WranglerSearchOptions = {}): readonly string[] => {
  const pathEntry = Object.entries(environment)
    .find(([key]) => key.toLowerCase() === "path")?.[1];
  if (!pathEntry) return [];

  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const joinPath = platform === "win32" ? win32.join : join;
  const extensions = platform === "win32"
    ? (Object.entries(environment)
        .find(([key]) => key.toLowerCase() === "pathext")?.[1]
        ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
    : [""];
  const seen = new Set<string>();
  const executables: string[] = [];

  for (const directory of pathEntry.split(pathDelimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = joinPath(directory, `wrangler${extension}`);
      const resolved = resolveExecutable(candidate);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      executables.push(candidate);
    }
  }

  return executables;
};

export const parseCloudflareAccountId = (value: string): CloudflareAccountId => {
  const normalized = value.trim().toLowerCase();
  if (!accountIdPattern.test(normalized)) {
    throw new Error("Expected a 32-character Cloudflare account ID");
  }
  return normalized as CloudflareAccountId;
};

export const parseWranglerIdentity = (value: unknown): WranglerIdentity => {
  if (!isRecord(value) || value.loggedIn !== true || !Array.isArray(value.accounts)) {
    throw new Error("Wrangler returned unexpected account data");
  }

  const accounts = value.accounts.map((account) => {
    if (
      !isRecord(account)
      || typeof account.id !== "string"
      || typeof account.name !== "string"
      || account.name.trim().length === 0
    ) {
      throw new Error("Wrangler returned unexpected account data");
    }
    return { id: parseCloudflareAccountId(account.id), name: account.name.trim() };
  });
  const email = typeof value.email === "string" && value.email.trim().length > 0
    ? value.email.trim()
    : undefined;

  return { accounts, ...(email === undefined ? {} : { email }) };
};

const defaultDependencies: WranglerDependencies = {
  findWranglers: findWranglerExecutables,
  runWrangler: async (command) => {
    const child = Bun.spawn(command, {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    return { exitCode, stdout };
  },
};

export const discoverWranglerIdentity = async (
  dependencies: WranglerDependencies = defaultDependencies
): Promise<WranglerDiscovery> => {
  const executables = dependencies.findWranglers();
  if (executables.length === 0) return { status: "unavailable" };

  let invalidResponse = false;
  for (const executable of executables) {
    try {
      const result = await dependencies.runWrangler([executable, "whoami", "--json"]);
      if (result.exitCode !== 0) continue;
      return {
        identity: parseWranglerIdentity(JSON.parse(result.stdout) as unknown),
        status: "authenticated",
      };
    } catch {
      invalidResponse = true;
    }
  }

  return { status: invalidResponse ? "invalid-response" : "unauthenticated" };
};
